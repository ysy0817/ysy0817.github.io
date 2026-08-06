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
// 内存缓存 · 避免每次打开都重新从云端拉取全部数据
// =====================================================
// _albumsCache: 相册列表（含 photo_count 与 cover_url）
// _photosCache: 按 albumId 缓存照片列表  { [albumId]: Photo[] }
// 通过 invalidate* 方法在增删改后失效对应缓存
const _cache = {
    albums: null,
    photos: new Map(),     // albumId -> Photo[]
    albumsAt: 0,           // 上次拉取时间戳
};

const CACHE_TTL = 60_000;  // 60s 内不重复请求云端（仍可被手动失效）

function invalidateAlbums() {
    _cache.albums = null;
    _cache.albumsAt = 0;
}
function invalidatePhotos(albumId) {
    if (albumId == null) _cache.photos.clear();
    else _cache.photos.delete(albumId);
}

// =====================================================
// 动态照片 (Motion Photo) 检测与 MP4 提取
// -----------------------------------------------------
// 现代 Android 手机拍摄的动态照片是「JPEG + 尾部追加 MP4」的单一文件，
// XMP 元数据中记录了视频起始偏移：
//   - GCamera:MotionPhotoOffset  从文件头算起的偏移（较新）
//   - GCamera:MicroVideoOffset   从文件尾算起的偏移（较旧）
// 此处解析后把 MP4 部分单独抽出来上传，原始 JPEG 保持不变。
// iPhone Live Photo 是两个独立文件（.jpg + .mov），需要用户分别上传，
// 当前不自动支持。
// =====================================================
function _findXMP(bytes) {
    // APP1 段：FF E1 [len2] "http://ns.adobe.com/xap/1.0/\0" [xmp...]
    const ns = 'http://ns.adobe.com/xap/1.0/';
    const nsBytes = new TextEncoder().encode(ns);
    for (let i = 0; i < bytes.length - 4 - nsBytes.length; i++) {
        if (bytes[i] !== 0xFF || bytes[i + 1] !== 0xE1) continue;
        let match = true;
        for (let j = 0; j < nsBytes.length; j++) {
            if (bytes[i + 4 + j] !== nsBytes[j]) { match = false; break; }
        }
        if (!match) continue;
        const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
        const xmpStart = i + 4 + nsBytes.length + 1;
        const xmpEnd = Math.min(i + 2 + segLen, bytes.length);
        return new TextDecoder('utf-8').decode(bytes.slice(xmpStart, xmpEnd));
    }
    return null;
}

function _findFtypOffset(bytes) {
    // MP4 box: [size4][ftyp]...  搜索 ASCII "ftyp"
    const t = [0x66, 0x74, 0x79, 0x70];
    // 从 JPEG 头之后开始搜索，避免误匹配
    for (let i = 100; i <= bytes.length - 8; i++) {
        if (bytes[i] === t[0] && bytes[i + 1] === t[1] &&
            bytes[i + 2] === t[2] && bytes[i + 3] === t[3]) {
            return i - 4;
        }
    }
    return -1;
}

/**
 * 从一个 JPEG 文件中提取嵌入的动态视频（如有）。
 * @param {File} file
 * @returns {Promise<Blob|null>} MP4 视频 Blob，不是动态照片则返回 null
 */
async function extractMotionVideo(file) {
    const isJpeg = file.type === 'image/jpeg' ||
        /\.jpe?g$/i.test(file.name);
    if (!isJpeg) return null;

    let bytes;
    try {
        bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
        return null;
    }
    if (bytes.length < 1024) return null;

    let videoOffset = -1;
    const xmp = _findXMP(bytes);
    if (xmp) {
        const motionOffsetMatch = xmp.match(/GCamera:MotionPhotoOffset="(\d+)"/);
        const microOffsetMatch = xmp.match(/GCamera:MicroVideoOffset="(\d+)"/);
        const hasMotion = /MotionPhoto="1"/.test(xmp) || /MicroVideo="1"/.test(xmp) ||
            motionOffsetMatch || microOffsetMatch;
        if (!hasMotion) return null;
        if (motionOffsetMatch) {
            videoOffset = parseInt(motionOffsetMatch[1], 10);
        } else if (microOffsetMatch) {
            videoOffset = bytes.length - parseInt(microOffsetMatch[1], 10);
        }
    }

    // 偏移无效时回退搜索 ftyp
    if (videoOffset < 0 || videoOffset >= bytes.length) {
        videoOffset = _findFtypOffset(bytes);
    }
    if (videoOffset < 0 || videoOffset >= bytes.length - 8) return null;

    const videoBytes = bytes.slice(videoOffset);
    // 校验确实是 ftyp box
    if (String.fromCharCode(...videoBytes.slice(4, 8)) !== 'ftyp') return null;
    return new Blob([videoBytes], { type: 'video/mp4' });
}

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
    async listAlbums(force = false) {
        const now = Date.now();
        if (!force && _cache.albums && now - _cache.albumsAt < CACHE_TTL) {
            return _cache.albums;
        }

        const { data, error } = await supabase
            .from('albums')
            .select('*')
            .order('created_at', { ascending: false });
        if (error) throw error;

        // 一次性查询所有照片计数，避免 N+1
        const { data: allPhotos, error: pErr } = await supabase
            .from('photos')
            .select('album_id, storage_path, motion_video_path, created_at');
        if (pErr) throw pErr;

        const byAlbum = new Map();
        for (const p of allPhotos) {
            if (!byAlbum.has(p.album_id)) byAlbum.set(p.album_id, []);
            byAlbum.get(p.album_id).push(p);
        }

        const result = data.map(album => {
            const photos = (byAlbum.get(album.id) || [])
                .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            return {
                ...album,
                photo_count: photos.length,
                cover_url: photos.length > 0
                    ? this.getThumbUrl({ storage_path: photos[0].storage_path }, 480)
                    : null,
            };
        });

        _cache.albums = result;
        _cache.albumsAt = now;
        return result;
    },

    async createAlbum({ name, description = '' }) {
        const { data, error } = await supabase
            .from('albums')
            .insert({ name: name.trim(), description: description.trim() })
            .select()
            .single();
        if (error) throw error;
        invalidateAlbums();
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
        invalidateAlbums();
        return data;
    },

    async deleteAlbum(id) {
        // 先获取所有照片路径用于清理 Storage
        const { data: photos, error: pErr } = await supabase
            .from('photos')
            .select('storage_path, motion_video_path')
            .eq('album_id', id);
        if (pErr) throw pErr;

        if (photos && photos.length > 0) {
            const paths = photos.flatMap(p => {
                const arr = [p.storage_path];
                if (p.motion_video_path) arr.push(p.motion_video_path);
                return arr;
            });
            const { error: delErr } = await supabase.storage.from(BUCKET).remove(paths);
            if (delErr) console.warn('Storage cleanup warning:', delErr.message);
        }

        // 删除相册（数据库 ON DELETE CASCADE 会自动删除关联的 photos 记录）
        const { error } = await supabase.from('albums').delete().eq('id', id);
        if (error) throw error;
        invalidateAlbums();
        invalidatePhotos(id);
    },

    // ---------- 照片操作 ----------
    async listPhotos(albumId, force = false) {
        if (!force && _cache.photos.has(albumId)) {
            return _cache.photos.get(albumId);
        }
        const { data, error } = await supabase
            .from('photos')
            .select('*')
            .eq('album_id', albumId)
            .order('created_at', { ascending: false });
        if (error) throw error;
        _cache.photos.set(albumId, data);
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

        // 尝试提取并上传动态照片中的 MP4（仅 Android Motion Photo 自动生效）
        let motionVideoPath = null;
        try {
            const motionBlob = await extractMotionVideo(file);
            if (motionBlob) {
                motionVideoPath = `${albumId}/${Date.now()}-motion-${Math.random().toString(36).slice(2, 10)}.mp4`;
                const { error: mvErr } = await supabase.storage
                    .from(BUCKET)
                    .upload(motionVideoPath, motionBlob, {
                        contentType: 'video/mp4',
                        upsert: false,
                    });
                if (mvErr) {
                    console.warn('Motion video upload failed:', mvErr.message);
                    motionVideoPath = null;
                }
            }
        } catch (e) {
            console.warn('Motion video extraction skipped:', e.message);
        }

        const { data, error } = await supabase
            .from('photos')
            .insert({
                album_id: albumId,
                name: file.name,
                type: file.type,
                size: file.size,
                note: note.trim(),
                storage_path: path,
                motion_video_path: motionVideoPath,
            })
            .select()
            .single();
        if (error) {
            // 数据库写入失败时回滚已上传的文件
            const rollback = [path];
            if (motionVideoPath) rollback.push(motionVideoPath);
            await supabase.storage.from(BUCKET).remove(rollback).catch(() => {});
            throw error;
        }
        invalidateAlbums();
        invalidatePhotos(albumId);
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
        // 备注变更不改变照片本身，仅同步缓存中的 note 字段
        for (const list of _cache.photos.values()) {
            const item = list.find(p => p.id === id);
            if (item) item.note = data.note;
        }
        return data;
    },

    async deletePhoto(id) {
        const { data: photo, error: gErr } = await supabase
            .from('photos')
            .select('album_id, storage_path, motion_video_path')
            .eq('id', id)
            .single();
        if (gErr) throw gErr;

        if (photo?.storage_path) {
            const paths = [photo.storage_path];
            if (photo.motion_video_path) paths.push(photo.motion_video_path);
            await supabase.storage.from(BUCKET).remove(paths).catch(() => {});
        }
        const { error } = await supabase.from('photos').delete().eq('id', id);
        if (error) throw error;
        invalidateAlbums();
        if (photo?.album_id) invalidatePhotos(photo.album_id);
    },

    /**
     * 获取照片原图访问 URL（公开 bucket 直接返回公开 URL）
     */
    getPhotoUrl(photo) {
        if (!photo || !photo.storage_path) return null;
        const { data } = supabase.storage.from(BUCKET).getPublicUrl(photo.storage_path);
        return data.publicUrl;
    },

    /**
     * 获取缩略图 URL —— 利用 Supabase 图片变换按需生成小尺寸图，
     * 网格视图加载量从「每张几 MB」降到「每张几十 KB」，显著缓解卡顿。
     * @param {object} photo
     * @param {number} size 目标边长（像素），默认 400
     */
    getThumbUrl(photo, size = 400) {
        if (!photo || !photo.storage_path) return null;
        const { data } = supabase.storage.from(BUCKET).getPublicUrl(photo.storage_path, {
            transform: { width: size, height: size, resize: 'cover', quality: 75 },
        });
        return data.publicUrl;
    },

    /**
     * 获取动态照片内嵌视频的访问 URL
     */
    getMotionVideoUrl(photo) {
        if (!photo || !photo.motion_video_path) return null;
        const { data } = supabase.storage.from(BUCKET).getPublicUrl(photo.motion_video_path);
        return data.publicUrl;
    },

    /** 是否为动态照片（含内嵌视频） */
    isMotionPhoto(photo) {
        return !!(photo && photo.motion_video_path);
    },
};

export const Storage = SupabaseAdapter;
