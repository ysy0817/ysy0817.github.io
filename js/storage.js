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

// =====================================================
// API 防御机制配置
// =====================================================
const API_CONFIG = {
    // 默认超时时间（毫秒）
    DEFAULT_TIMEOUT: 15000,
    // 上传类操作超时（毫秒）
    UPLOAD_TIMEOUT: 60000,
    // 最大重试次数
    MAX_RETRIES: 3,
    // 初始重试延迟（毫秒），后续按指数退避
    RETRY_BASE_DELAY: 500,
    // 最大重试延迟（毫秒）
    RETRY_MAX_DELAY: 5000,
};

// =====================================================
// 错误分类常量
// =====================================================
const ERROR_TYPES = {
    NETWORK: 'NETWORK',           // 网络连接失败
    TIMEOUT: 'TIMEOUT',           // 请求超时
    AUTH: 'AUTH',                 // 认证失败 / 未登录 / token 过期
    RATE_LIMIT: 'RATE_LIMIT',     // 限流 (429)
    SERVER: 'SERVER',             // 服务端 5xx 错误
    NOT_FOUND: 'NOT_FOUND',       // 资源不存在
    CONFLICT: 'CONFLICT',         // 资源冲突
    VALIDATION: 'VALIDATION',     // 参数校验失败
    STORAGE: 'STORAGE',           // 存储操作失败
    UNKNOWN: 'UNKNOWN',           // 其他未知错误
};

// =====================================================
// 工具：错误分类与友好提示
// =====================================================
function classifyError(error) {
    if (!error) return { type: ERROR_TYPES.UNKNOWN, message: '未知错误' };

    const msg = (error.message || '').toString();
    const status = error.status || (error.response && error.response.status) || 0;

    // 1. 超时错误
    if (error.name === 'TimeoutError' || msg.includes('timeout') || msg.includes('Timeout')) {
        return { type: ERROR_TYPES.TIMEOUT, message: '请求超时，请检查网络后重试' };
    }

    // 2. 网络错误（无网络、DNS 失败、CORS 预检失败等）
    if (
        error.name === 'NetworkError' ||
        error.name === 'FetchError' ||
        msg.includes('Failed to fetch') ||
        msg.includes('NetworkError') ||
        msg.includes('Network request failed') ||
        msg.includes('load failed') ||
        msg.includes('CORS') ||
        (typeof navigator !== 'undefined' && navigator.onLine === false)
    ) {
        return { type: ERROR_TYPES.NETWORK, message: '网络连接失败，请检查网络设置' };
    }

    // 3. 认证 / 未授权
    if (
        status === 401 ||
        msg.includes('JWT') ||
        msg.includes('jwt') ||
        msg.includes('Invalid login') ||
        msg.includes('Invalid credentials') ||
        msg.includes('unauthorized') ||
        msg.includes('Unauthorized') ||
        msg.includes('not authenticated') ||
        msg.includes('session') ||
        msg.includes('token')
    ) {
        if (msg.includes('Email not confirmed')) {
            return { type: ERROR_TYPES.AUTH, message: '账号未激活，请在 Supabase 控制台勾选 Auto Confirm User' };
        }
        if (msg.includes('Invalid login') || msg.includes('Invalid credentials')) {
            return { type: ERROR_TYPES.AUTH, message: '密码错误' };
        }
        return { type: ERROR_TYPES.AUTH, message: '登录已过期，请重新登录' };
    }

    // 4. 权限不足
    if (status === 403 || msg.includes('forbidden') || msg.includes('Forbidden') || msg.includes('policy')) {
        return { type: ERROR_TYPES.AUTH, message: '没有操作权限，请重新登录' };
    }

    // 5. 限流
    if (
        status === 429 ||
        msg.includes('rate limit') ||
        msg.includes('Rate limit') ||
        msg.includes('too many requests') ||
        msg.includes('Too Many Requests')
    ) {
        return { type: ERROR_TYPES.RATE_LIMIT, message: '请求过于频繁，请稍后再试' };
    }

    // 6. 服务端错误
    if (status >= 500 && status < 600) {
        return { type: ERROR_TYPES.SERVER, message: '服务器暂时不可用，请稍后重试' };
    }

    // 7. 资源不存在
    if (status === 404 || msg.includes('not found') || msg.includes('Not Found')) {
        return { type: ERROR_TYPES.NOT_FOUND, message: '请求的资源不存在' };
    }

    // 8. 资源冲突
    if (status === 409 || msg.includes('conflict') || msg.includes('Conflict') || msg.includes('duplicate')) {
        return { type: ERROR_TYPES.CONFLICT, message: '资源冲突，请刷新后重试' };
    }

    // 9. 参数校验失败（Supabase 返回的 400/422）
    if (
        status === 400 ||
        status === 422 ||
        msg.includes('validation') ||
        msg.includes('Validation') ||
        msg.includes('invalid') ||
        msg.includes('Invalid')
    ) {
        return { type: ERROR_TYPES.VALIDATION, message: msg || '提交的数据有误，请检查后重试' };
    }

    // 10. Supabase Storage 特定错误
    if (msg.includes('storage') || msg.includes('Storage') || msg.includes('bucket') || msg.includes('object')) {
        return { type: ERROR_TYPES.STORAGE, message: '文件存储操作失败：' + msg };
    }

    // 默认：保留原始错误信息（仅展示，不暴露内部细节）
    return { type: ERROR_TYPES.UNKNOWN, message: msg || '操作失败，请稍后重试' };
}

// =====================================================
// 工具：超时 Promise 包装器
// =====================================================
function withTimeout(promise, timeoutMs, label = '') {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const err = new Error(`请求超时${label ? '（' + label + '）' : ''}`);
            err.name = 'TimeoutError';
            reject(err);
        }, timeoutMs);

        promise
            .then((result) => {
                clearTimeout(timer);
                resolve(result);
            })
            .catch((err) => {
                clearTimeout(timer);
                reject(err);
            });
    });
}

// =====================================================
// 工具：等待指定时间（用于重试间隔）
// =====================================================
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// =====================================================
// 工具：判断错误是否可重试
// =====================================================
function isRetryable(error) {
    const { type } = classifyError(error);
    // 可重试：网络错误、超时、限流、服务端错误、未知错误
    return (
        type === ERROR_TYPES.NETWORK ||
        type === ERROR_TYPES.TIMEOUT ||
        type === ERROR_TYPES.RATE_LIMIT ||
        type === ERROR_TYPES.SERVER ||
        type === ERROR_TYPES.UNKNOWN
    );
}

// =====================================================
// 核心：带超时 + 指数退避重试 + 错误分类的请求包装器
// =====================================================
async function safeRequest(fn, options = {}) {
    const {
        timeout = API_CONFIG.DEFAULT_TIMEOUT,
        maxRetries = API_CONFIG.MAX_RETRIES,
        label = '',
        onAuthExpired = null,
    } = options;

    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await withTimeout(
                (async () => fn())(),
                timeout,
                attempt > 0 ? `${label} · 第${attempt + 1}次尝试` : label
            );

            // Supabase 返回 { data, error } 结构时，需要额外判断 error 字段
            if (result && typeof result === 'object' && 'error' in result && result.error) {
                throw result.error;
            }

            return result;
        } catch (err) {
            lastError = err;
            const classified = classifyError(err);

            // 认证失效：首次尝试就触发回调（不重试）
            if (classified.type === ERROR_TYPES.AUTH) {
                console.warn(`[API] 认证失败 (${label}):`, classified.message);
                if (onAuthExpired && attempt === 0) {
                    try { onAuthExpired(); } catch (_) { /* ignore */ }
                }
                // 重新抛出带分类信息的错误
                const enhancedErr = new Error(classified.message);
                enhancedErr.originalError = err;
                enhancedErr.errorType = classified.type;
                throw enhancedErr;
            }

            // 不可重试错误或重试次数用尽：抛出
            if (!isRetryable(err) || attempt >= maxRetries) {
                console.error(
                    `[API] ${label || '请求'} 失败` +
                    (attempt > 0 ? `（重试 ${attempt} 次后仍失败）` : '') +
                    ':',
                    classified.message
                );
                const enhancedErr = new Error(classified.message);
                enhancedErr.originalError = err;
                enhancedErr.errorType = classified.type;
                enhancedErr.attempts = attempt + 1;
                throw enhancedErr;
            }

            // 指数退避：500ms → 1000ms → 2000ms → ... 上限 5s
            const backoff = Math.min(
                API_CONFIG.RETRY_BASE_DELAY * Math.pow(2, attempt),
                API_CONFIG.RETRY_MAX_DELAY
            );
            // 限流时额外增加等待
            const extraDelay = classified.type === ERROR_TYPES.RATE_LIMIT ? 1500 : 0;
            const waitMs = backoff + extraDelay;

            console.warn(
                `[API] ${label || '请求'} 第 ${attempt + 1} 次失败` +
                `（${classified.message}），${(waitMs / 1000).toFixed(1)}s 后重试...`
            );
            await delay(waitMs);
        }
    }

    // 兜底（理论上不会到达）
    const classified = classifyError(lastError);
    const enhancedErr = new Error(classified.message);
    enhancedErr.originalError = lastError;
    enhancedErr.errorType = classified.type;
    throw enhancedErr;
}

// =====================================================
// 回调：认证过期时通知上层（由 app.js 监听）
// =====================================================
const authListeners = new Set();
function onAuthExpired(callback) {
    authListeners.add(callback);
    return () => authListeners.delete(callback);
}
function notifyAuthExpired() {
    authListeners.forEach((cb) => {
        try { cb(); } catch (_) { /* ignore */ }
    });
}

// =====================================================
// Supabase 客户端初始化
// =====================================================
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
    },
});

// 监听 Supabase 自带的认证状态变化（TOKEN 过期、被登出等）
supabase.auth.onAuthStateChange((event) => {
    if (event === 'TOKEN_REFRESHED') {
        console.info('[Auth] Token 自动刷新成功');
    } else if (event === 'SIGNED_OUT') {
        console.info('[Auth] 用户已登出');
        notifyAuthExpired();
    }
});

// =====================================================
// Auth 模块 · 密码验证
// =====================================================
export const Auth = {
    /**
     * 用密码登录（邮箱由 config.js 提供，密码由用户输入）
     * 登录不重试（密码错误等重试无意义），仅加超时
     * @param {string} password 用户输入的密码
     */
    async signIn(password) {
        const result = await safeRequest(
            () => supabase.auth.signInWithPassword({
                email: AUTH_EMAIL,
                password,
            }),
            {
                timeout: API_CONFIG.DEFAULT_TIMEOUT,
                maxRetries: 0, // 登录操作不重试
                label: '用户登录',
            }
        );
        return result.data;
    },

    /** 退出登录 */
    async signOut() {
        try {
            await safeRequest(
                () => supabase.auth.signOut(),
                {
                    timeout: API_CONFIG.DEFAULT_TIMEOUT,
                    maxRetries: 1,
                    label: '退出登录',
                }
            );
        } catch (e) {
            // 退出登录即使失败也视为成功（本地清理即可）
            console.warn('[Auth] signOut 请求失败，继续本地清理：', e.message);
        }
    },

    /** 获取当前会话 */
    async getSession() {
        const result = await safeRequest(
            () => supabase.auth.getSession(),
            {
                timeout: API_CONFIG.DEFAULT_TIMEOUT,
                maxRetries: 1,
                label: '获取登录状态',
            }
        );
        return result.data.session;
    },

    /** 监听认证状态变化 */
    onAuthStateChange(callback) {
        return supabase.auth.onAuthStateChange((event, session) => {
            callback(event, session);
        });
    },
};

// 导出认证过期监听（供 app.js 使用）
export { onAuthExpired, ERROR_TYPES };

// =====================================================
// Storage 模块 · 相册与照片 CRUD
// =====================================================
const SupabaseAdapter = {
    // ---------- 相册操作 ----------
    async listAlbums() {
        // 第一步：获取相册列表
        const albumsResult = await safeRequest(
            () => supabase
                .from('albums')
                .select('*')
                .order('created_at', { ascending: false }),
            {
                timeout: API_CONFIG.DEFAULT_TIMEOUT,
                label: '获取相册列表',
                onAuthExpired: notifyAuthExpired,
            }
        );
        const data = albumsResult.data;

        // 第二步：一次性查询所有照片（避免 N+1）
        const photosResult = await safeRequest(
            () => supabase
                .from('photos')
                .select('album_id, storage_path, created_at'),
            {
                timeout: API_CONFIG.DEFAULT_TIMEOUT,
                label: '获取照片概览',
                onAuthExpired: notifyAuthExpired,
            }
        );
        const allPhotos = photosResult.data;

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
        const result = await safeRequest(
            () => supabase
                .from('albums')
                .insert({ name: name.trim(), description: description.trim() })
                .select()
                .single(),
            {
                timeout: API_CONFIG.DEFAULT_TIMEOUT,
                maxRetries: 1, // 写操作谨慎重试（避免重复创建）
                label: '创建相册',
                onAuthExpired: notifyAuthExpired,
            }
        );
        return { ...result.data, photo_count: 0, cover_url: null };
    },

    async updateAlbum(id, { name, description }) {
        const update = {};
        if (name !== undefined) update.name = name.trim();
        if (description !== undefined) update.description = description.trim();
        const result = await safeRequest(
            () => supabase
                .from('albums')
                .update(update)
                .eq('id', id)
                .select()
                .single(),
            {
                timeout: API_CONFIG.DEFAULT_TIMEOUT,
                maxRetries: 1,
                label: '更新相册',
                onAuthExpired: notifyAuthExpired,
            }
        );
        return result.data;
    },

    async deleteAlbum(id) {
        // 第一步：获取所有照片路径用于清理 Storage
        const photosResult = await safeRequest(
            () => supabase
                .from('photos')
                .select('storage_path')
                .eq('album_id', id),
            {
                timeout: API_CONFIG.DEFAULT_TIMEOUT,
                label: '查询相册照片路径',
                onAuthExpired: notifyAuthExpired,
            }
        );
        const photos = photosResult.data;

        if (photos && photos.length > 0) {
            const paths = photos.map(p => p.storage_path);
            try {
                await safeRequest(
                    () => supabase.storage.from(BUCKET).remove(paths),
                    {
                        timeout: API_CONFIG.UPLOAD_TIMEOUT,
                        maxRetries: 2,
                        label: '批量清理照片文件',
                    }
                );
            } catch (delErr) {
                // Storage 清理失败不阻断数据库删除，记录警告即可
                console.warn('[Storage] 删除相册时清理 Storage 部分失败：', delErr.message);
            }
        }

        // 第二步：删除相册（数据库 ON DELETE CASCADE 会自动删除关联的 photos 记录）
        await safeRequest(
            () => supabase.from('albums').delete().eq('id', id),
            {
                timeout: API_CONFIG.DEFAULT_TIMEOUT,
                maxRetries: 1,
                label: '删除相册',
                onAuthExpired: notifyAuthExpired,
            }
        );
    },

    // ---------- 照片操作 ----------
    async listPhotos(albumId) {
        const result = await safeRequest(
            () => supabase
                .from('photos')
                .select('*')
                .eq('album_id', albumId)
                .order('created_at', { ascending: false }),
            {
                timeout: API_CONFIG.DEFAULT_TIMEOUT,
                label: `获取照片列表[${albumId}]`,
                onAuthExpired: notifyAuthExpired,
            }
        );
        return result.data;
    },

    async uploadPhoto(file, albumId, note = '') {
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
        const path = `${albumId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;

        // 第一步：上传文件到 Storage（不上传重试，避免重复计费/重复占用空间）
        try {
            await safeRequest(
                () => supabase.storage
                    .from(BUCKET)
                    .upload(path, file, {
                        contentType: file.type || 'image/jpeg',
                        upsert: false,
                    }),
                {
                    timeout: API_CONFIG.UPLOAD_TIMEOUT,
                    maxRetries: 1, // 文件上传只重试 1 次（网络抖动场景）
                    label: `上传照片 ${file.name}`,
                    onAuthExpired: notifyAuthExpired,
                }
            );
        } catch (upErr) {
            // 上传失败，不回滚（还没写入数据库，无数据一致性问题）
            throw upErr;
        }

        // 第二步：写入数据库记录
        try {
            const result = await safeRequest(
                () => supabase
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
                    .single(),
                {
                    timeout: API_CONFIG.DEFAULT_TIMEOUT,
                    maxRetries: 1,
                    label: `写入照片记录 ${file.name}`,
                    onAuthExpired: notifyAuthExpired,
                }
            );
            return result.data;
        } catch (dbErr) {
            // 数据库写入失败时回滚已上传的文件
            console.warn('[Storage] 数据库写入失败，回滚已上传文件：', path);
            await supabase.storage.from(BUCKET).remove([path]).catch((cleanErr) => {
                console.error('[Storage] 回滚失败，存在孤立文件：', path, cleanErr.message);
            });
            throw dbErr;
        }
    },

    async updatePhoto(id, { note }) {
        const result = await safeRequest(
            () => supabase
                .from('photos')
                .update({ note: note.trim() })
                .eq('id', id)
                .select()
                .single(),
            {
                timeout: API_CONFIG.DEFAULT_TIMEOUT,
                maxRetries: 1,
                label: `更新照片备注[${id}]`,
                onAuthExpired: notifyAuthExpired,
            }
        );
        return result.data;
    },

    async deletePhoto(id) {
        // 第一步：查询照片路径
        const photoResult = await safeRequest(
            () => supabase
                .from('photos')
                .select('storage_path')
                .eq('id', id)
                .single(),
            {
                timeout: API_CONFIG.DEFAULT_TIMEOUT,
                label: `查询照片路径[${id}]`,
                onAuthExpired: notifyAuthExpired,
            }
        );
        const photo = photoResult.data;

        if (photo?.storage_path) {
            try {
                await safeRequest(
                    () => supabase.storage.from(BUCKET).remove([photo.storage_path]),
                    {
                        timeout: API_CONFIG.DEFAULT_TIMEOUT,
                        maxRetries: 2,
                        label: `删除照片文件[${id}]`,
                    }
                );
            } catch (cleanErr) {
                console.warn('[Storage] 删除 Storage 文件失败，继续删除 DB 记录：', cleanErr.message);
            }
        }

        // 第二步：删除数据库记录
        await safeRequest(
            () => supabase.from('photos').delete().eq('id', id),
            {
                timeout: API_CONFIG.DEFAULT_TIMEOUT,
                maxRetries: 1,
                label: `删除照片记录[${id}]`,
                onAuthExpired: notifyAuthExpired,
            }
        );
    },

    /**
     * 获取照片访问 URL（公开 bucket 直接返回公开 URL）
     * 纯本地计算，无 API 调用，不需要防御包装
     */
    getPhotoUrl(photo) {
        if (!photo || !photo.storage_path) return null;
        const { data } = supabase.storage.from(BUCKET).getPublicUrl(photo.storage_path);
        return data.publicUrl;
    },
};

export const Storage = SupabaseAdapter;
