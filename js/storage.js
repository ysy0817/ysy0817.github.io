/**
 * 存储层 · Supabase 实现
 *
 * 包含两部分：
 *   1. Auth     - 密码验证（基于 Supabase Auth）
 *   2. Storage  - 相册与照片的 CRUD（基于 Supabase Database + Storage）
 *
 * 安全模型：
 *   - 密码不存在于代码中，由 Supabase Auth 管理
 *   - 前端通过固定邮箱 + 用户输入的密码登录
 *   - 登录后获得 access_token，所有数据库/存储请求自动携带
 *   - RLS 策略确保只有 authenticated 用户能读写
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, AUTH_EMAIL } from './config.js';

const BUCKET = 'photos';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
    },
});

// =====================================================
// Auth 模块 · 密码验证
// =====================================================
export const Auth = {
    /**
     * 用密码登录（邮箱由 config.js 提供，密码由用户输入）
     * @param {string} password 用户输入的密码
     */
    async signIn(password) {
        const { data, error } = await supabase.auth.signInWithPassword({
            email: AUTH_EMAIL,
            password,
        });
        if (error) throw error;
        return data;
    },

    /** 退出登录 */
    async signOut() {
        await supabase.auth.signOut();
    },

    /** 获取当前会话 */
    async getSession() {
        const { data } = await supabase.auth.getSession();
        return data.session;
    },

    /** 监听认证状态变化 */
    onAuthStateChange(callback) {
        return supabase.auth.onAuthStateChange((event, session) => {
            callback(event, session);
        });
    },
};

// =====================================================
// Storage 模块 · 相册与照片 CRUD
// =====================================================
const SupabaseAdapter = {
    // ---------- 相册操作 ----------
    async listAlbums() {
        const { data, error } = await supabase
            .from('albums')
            .select('*')
            .order('created_at', { ascending: false });
        if (error) throw error;

        // 一次性查询所有照片计数，避免 N+1
        const { data: allPhotos, error: pErr } = await supabase
            .from('photos')
            .select('album_id, storage_path, created_at');
        if (pErr) throw pErr;

        const byAlbum = new Map();
        for (const p of allPhotos) {
            if (!byAlbum.has(p.album_id)) byAlbum.set(p.album_id, []);
            byAlbum.get(p.album_id).push(p);
        }

        return data.map(album => {
            const photos = (byAlbum.get(album.id) || [])
                .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            return {
                ...album,
                photo_count: photos.length,
                cover_url: photos.length > 0 ? this.getPhotoUrl({ storage_path: photos[0].storage_path }) : null,
            };
        });
    },

    async createAlbum({ name, description = '' }) {
        const { data, error } = await supabase
            .from('albums')
            .insert({ name: name.trim(), description: description.trim() })
            .select()
            .single();
        if (error) throw error;
        return { ...data, photo_count: 0, cover_url: null };
    },

    async updateAlbum(id, { name, description }) {
        const update = {};
        if (name !== undefined) update.name = name.trim();
        if (description !== undefined) update.description = description.trim();
        const { data, error } = await supabase
            .from('albums')
            .update(update)
            .eq('id', id)
            .select()
            .single();
        if (error) throw error;
        return data;
    },

    async deleteAlbum(id) {
        // 先获取所有照片路径用于清理 Storage
        const { data: photos, error: pErr } = await supabase
            .from('photos')
            .select('storage_path')
            .eq('album_id', id);
        if (pErr) throw pErr;

        if (photos && photos.length > 0) {
            const paths = photos.map(p => p.storage_path);
            const { error: delErr } = await supabase.storage.from(BUCKET).remove(paths);
            if (delErr) console.warn('Storage cleanup warning:', delErr.message);
        }

        // 删除相册（数据库 ON DELETE CASCADE 会自动删除关联的 photos 记录）
        const { error } = await supabase.from('albums').delete().eq('id', id);
        if (error) throw error;
    },

    // ---------- 照片操作 ----------
    async listPhotos(albumId) {
        const { data, error } = await supabase
            .from('photos')
            .select('*')
            .eq('album_id', albumId)
            .order('created_at', { ascending: false });
        if (error) throw error;
        return data;
    },

    async uploadPhoto(file, albumId, note = '') {
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
        const path = `${albumId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;

        const { error: upErr } = await supabase.storage
            .from(BUCKET)
            .upload(path, file, {
                contentType: file.type || 'image/jpeg',
                upsert: false,
            });
        if (upErr) throw upErr;

        const { data, error } = await supabase
            .from('photos')
            .insert({
                album_id: albumId,
                name: file.name,
                type: file.type,
                size: file.size,
                note: note.trim(),
                storage_path: path,
            })
            .select()
            .single();
        if (error) {
            // 数据库写入失败时回滚已上传的文件
            await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
            throw error;
        }
        return data;
    },

    async updatePhoto(id, { note }) {
        const { data, error } = await supabase
            .from('photos')
            .update({ note: note.trim() })
            .eq('id', id)
            .select()
            .single();
        if (error) throw error;
        return data;
    },

    async deletePhoto(id) {
        const { data: photo, error: gErr } = await supabase
            .from('photos')
            .select('storage_path')
            .eq('id', id)
            .single();
        if (gErr) throw gErr;

        if (photo?.storage_path) {
            await supabase.storage.from(BUCKET).remove([photo.storage_path]).catch(() => {});
        }
        const { error } = await supabase.from('photos').delete().eq('id', id);
        if (error) throw error;
    },

    /**
     * 获取照片访问 URL（公开 bucket 直接返回公开 URL）
     */
    getPhotoUrl(photo) {
        if (!photo || !photo.storage_path) return null;
        const { data } = supabase.storage.from(BUCKET).getPublicUrl(photo.storage_path);
        return data.publicUrl;
    },
};

export const Storage = SupabaseAdapter;
