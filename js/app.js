/**
 * 云相册 · 主应用逻辑
 */
import { Storage, Auth } from './storage.js';

// =====================================================
// 应用状态
// =====================================================
const state = {
    view: 'albums',        // 'albums' | 'photos'
    albums: [],
    currentAlbum: null,
    photos: [],
    lightboxIndex: -1,
    pendingFiles: [],      // 待上传的文件
    editingAlbumId: null,
    confirmCallback: null,
};

// =====================================================
// DOM 引用
// =====================================================
const $ = (sel) => document.querySelector(sel);
const els = {
    albumsView: $('#albumsView'),
    photosView: $('#photosView'),
    albumGrid: $('#albumGrid'),
    photoGrid: $('#photoGrid'),
    albumCount: $('#albumCount'),
    photoCount: $('#photoCount'),
    albumsEmpty: $('#albumsEmpty'),
    photosEmpty: $('#photosEmpty'),
    viewTitle: $('#viewTitle'),
    currentAlbumName: $('#currentAlbumName'),
    backBtn: $('#backBtn'),
    newAlbumBtn: $('#newAlbumBtn'),
    uploadBtn: $('#uploadBtn'),
    logoutBtn: $('#logoutBtn'),

    // 密码验证
    authOverlay: $('#authOverlay'),
    authInput: $('#authInput'),
    authSubmit: $('#authSubmit'),
    authError: $('#authError'),
    authLoading: $('#authLoading'),

    // 相册模态框
    albumModal: $('#albumModal'),
    albumModalTitle: $('#albumModalTitle'),
    albumNameInput: $('#albumNameInput'),
    albumDescInput: $('#albumDescInput'),
    albumCancelBtn: $('#albumCancelBtn'),
    albumSaveBtn: $('#albumSaveBtn'),

    // 上传模态框
    uploadModal: $('#uploadModal'),
    uploadZone: $('#uploadZone'),
    fileInput: $('#fileInput'),
    uploadPreview: $('#uploadPreview'),
    uploadCancelBtn: $('#uploadCancelBtn'),
    uploadConfirmBtn: $('#uploadConfirmBtn'),

    // 确认对话框
    confirmModal: $('#confirmModal'),
    confirmTitle: $('#confirmTitle'),
    confirmText: $('#confirmText'),
    confirmCancelBtn: $('#confirmCancelBtn'),
    confirmOkBtn: $('#confirmOkBtn'),

    // 大图查看器
    lightbox: $('#lightbox'),
    lightboxImg: $('#lightboxImg'),
    lightboxVideo: $('#lightboxVideo'),
    motionBadge: $('#motionBadge'),
    motionToggle: $('#motionToggle'),
    lightboxClose: $('#lightboxClose'),
    lightboxPrev: $('#lightboxPrev'),
    lightboxNext: $('#lightboxNext'),
    noteEditor: $('#noteEditor'),
    photoMeta: $('#photoMeta'),
    deletePhotoBtn: $('#deletePhotoBtn'),

    toast: $('#toast'),
};

// =====================================================
// 工具函数
// =====================================================
function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatDate(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)} 天前`;
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

let toastTimer = null;
function toast(msg, type = '') {
    clearTimeout(toastTimer);
    els.toast.textContent = msg;
    els.toast.className = 'toast show ' + type;
    toastTimer = setTimeout(() => {
        els.toast.className = 'toast ' + type;
    }, 2600);
}

function openModal(modalEl) {
    modalEl.classList.add('active');
}
function closeModal(modalEl) {
    modalEl.classList.remove('active');
}

function showConfirm(options) {
    const { title = '确认操作', text = '', okText = '确认', danger = true, onOk } = options;
    els.confirmTitle.textContent = title;
    els.confirmText.textContent = text;
    els.confirmOkBtn.textContent = okText;
    els.confirmOkBtn.className = danger ? 'btn-danger' : 'btn-primary';
    state.confirmCallback = onOk;
    openModal(els.confirmModal);
}

// =====================================================
// 视图渲染
// =====================================================
async function renderAlbums() {
    try {
        state.albums = await Storage.listAlbums();
    } catch (e) {
        console.error(e);
        toast('加载相册失败', 'error');
        state.albums = [];
    }

    els.albumCount.textContent = `${state.albums.length} 个相册`;
    els.albumsEmpty.hidden = state.albums.length > 0;
    els.albumGrid.innerHTML = state.albums.map(album => `
        <div class="album-card" data-id="${album.id}">
            ${album.cover_url
                ? `<div class="album-cover" style="background-image:url('${album.cover_url}')"></div>`
                : `<div class="album-cover-empty">📷</div>`}
            <div class="album-overlay">
                <div class="album-name">${escapeHTML(album.name)}</div>
                ${album.description ? `<div class="album-desc">${escapeHTML(album.description)}</div>` : ''}
                <div class="album-meta">
                    <span>${album.photo_count} 张照片 · ${formatDate(album.created_at)}</span>
                </div>
            </div>
            <div class="album-actions">
                <button class="album-action-btn" data-action="edit" data-id="${album.id}" title="编辑">
                    <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                </button>
                <button class="album-action-btn" data-action="delete" data-id="${album.id}" title="删除">
                    <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                </button>
            </div>
        </div>
    `).join('');
}

async function renderPhotos() {
    if (!state.currentAlbum) return;
    try {
        state.photos = await Storage.listPhotos(state.currentAlbum.id);
    } catch (e) {
        console.error(e);
        toast('加载照片失败', 'error');
        state.photos = [];
    }

    els.photoCount.textContent = `${state.photos.length} 张照片`;
    els.photosEmpty.hidden = state.photos.length > 0;
    els.photoGrid.innerHTML = state.photos.map((photo, idx) => {
        const url = Storage.getThumbUrl(photo);
        const isMotion = Storage.isMotionPhoto(photo);
        return `
            <div class="photo-card" data-index="${idx}">
                ${url ? `<img src="${url}" alt="${escapeHTML(photo.name)}" loading="lazy" decoding="async">` : ''}
                ${isMotion ? `<span class="photo-motion-badge" title="动态照片">▶ 动态</span>` : ''}
                ${photo.note ? `<div class="photo-note-badge">📝</div>` : ''}
                ${photo.note ? `
                    <div class="photo-overlay">
                        <div class="photo-note-text">${escapeHTML(photo.note)}</div>
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

// =====================================================
// 视图切换
// =====================================================
function showAlbumsView() {
    state.view = 'albums';
    state.currentAlbum = null;
    els.albumsView.hidden = false;
    els.photosView.hidden = true;
    els.backBtn.hidden = true;
    els.uploadBtn.hidden = true;
    els.newAlbumBtn.hidden = false;
    els.viewTitle.textContent = '我的相册';
    renderAlbums();
}

function showPhotosView(album) {
    state.view = 'photos';
    state.currentAlbum = album;
    els.albumsView.hidden = true;
    els.photosView.hidden = false;
    els.backBtn.hidden = false;
    els.uploadBtn.hidden = false;
    els.newAlbumBtn.hidden = true;
    els.currentAlbumName.textContent = album.name;
    els.viewTitle.textContent = album.name;
    renderPhotos();
}

// =====================================================
// 相册操作
// =====================================================
function openCreateAlbumModal() {
    state.editingAlbumId = null;
    els.albumModalTitle.textContent = '新建相册';
    els.albumNameInput.value = '';
    els.albumDescInput.value = '';
    openModal(els.albumModal);
    setTimeout(() => els.albumNameInput.focus(), 100);
}

function openEditAlbumModal(albumId) {
    const album = state.albums.find(a => a.id === albumId);
    if (!album) return;
    state.editingAlbumId = albumId;
    els.albumModalTitle.textContent = '编辑相册';
    els.albumNameInput.value = album.name;
    els.albumDescInput.value = album.description || '';
    openModal(els.albumModal);
    setTimeout(() => els.albumNameInput.focus(), 100);
}

async function saveAlbum() {
    const name = els.albumNameInput.value.trim();
    if (!name) {
        toast('请输入相册名称', 'error');
        els.albumNameInput.focus();
        return;
    }
    const description = els.albumDescInput.value;

    try {
        els.albumSaveBtn.disabled = true;
        els.albumSaveBtn.textContent = '保存中...';

        if (state.editingAlbumId) {
            await Storage.updateAlbum(state.editingAlbumId, { name, description });
            toast('相册已更新', 'success');
        } else {
            await Storage.createAlbum({ name, description });
            toast('相册已创建', 'success');
        }
        closeModal(els.albumModal);
        await renderAlbums();
    } catch (e) {
        console.error(e);
        toast('保存失败：' + e.message, 'error');
    } finally {
        els.albumSaveBtn.disabled = false;
        els.albumSaveBtn.textContent = '保存';
    }
}

function deleteAlbum(albumId) {
    const album = state.albums.find(a => a.id === albumId);
    if (!album) return;
    showConfirm({
        title: '删除相册',
        text: `确定要删除「${album.name}」吗？相册内的所有 ${album.photo_count} 张照片将一并删除，且无法恢复。`,
        okText: '删除',
        onOk: async () => {
            try {
                await Storage.deleteAlbum(albumId);
                toast('相册已删除', 'success');
                await renderAlbums();
            } catch (e) {
                console.error(e);
                toast('删除失败：' + e.message, 'error');
            }
        },
    });
}

// =====================================================
// 照片操作
// =====================================================
function openUploadModal() {
    if (!state.currentAlbum) return;
    state.pendingFiles = [];
    els.uploadPreview.innerHTML = '';
    els.uploadConfirmBtn.disabled = true;
    openModal(els.uploadModal);
}

function handleFiles(files) {
    const valid = [];
    const max = 20 * 1024 * 1024;
    for (const f of files) {
        if (!f.type.startsWith('image/')) {
            toast(`已跳过非图片文件：${f.name}`, 'error');
            continue;
        }
        if (f.size > max) {
            toast(`已跳过超限文件（>20MB）：${f.name}`, 'error');
            continue;
        }
        valid.push(f);
    }
    if (valid.length === 0) return;

    state.pendingFiles.push(...valid);
    renderUploadPreview();
}

function renderUploadPreview() {
    els.uploadPreview.innerHTML = state.pendingFiles.map((f, i) => `
        <div class="upload-thumb">
            <img src="${URL.createObjectURL(f)}" alt="">
            <button class="upload-thumb-remove" data-idx="${i}" title="移除">×</button>
        </div>
    `).join('');
    els.uploadConfirmBtn.disabled = state.pendingFiles.length === 0;
}

async function confirmUpload() {
    if (state.pendingFiles.length === 0) return;
    try {
        els.uploadConfirmBtn.disabled = true;
        els.uploadConfirmBtn.textContent = `上传中 0/${state.pendingFiles.length}`;
        let done = 0;
        for (const file of state.pendingFiles) {
            await Storage.uploadPhoto(file, state.currentAlbum.id, '');
            done++;
            els.uploadConfirmBtn.textContent = `上传中 ${done}/${state.pendingFiles.length}`;
        }
        toast(`成功上传 ${done} 张照片`, 'success');
        state.pendingFiles = [];
        closeModal(els.uploadModal);
        await renderPhotos();
    } catch (e) {
        console.error(e);
        toast('上传失败：' + e.message, 'error');
    } finally {
        els.uploadConfirmBtn.disabled = false;
        els.uploadConfirmBtn.textContent = '上传';
    }
}

// ---------- 大图查看器 ----------
function openLightbox(index) {
    if (index < 0 || index >= state.photos.length) return;
    state.lightboxIndex = index;
    renderLightbox();
    els.lightbox.classList.add('active');
}

function closeLightbox() {
    els.lightbox.classList.remove('active');
    // 停止动态照片视频
    if (els.lightboxVideo && !els.lightboxVideo.hidden) {
        els.lightboxVideo.pause();
        els.lightboxVideo.removeAttribute('src');
        els.lightboxVideo.load();
    }
    // 关闭时自动保存备注
    saveNoteIfNeeded();
    state.lightboxIndex = -1;
}

function renderLightbox() {
    const photo = state.photos[state.lightboxIndex];
    if (!photo) return;
    const url = Storage.getPhotoUrl(photo);
    els.lightboxImg.hidden = false;        // 默认显示静态图（动态视频默认不自动播放）
    els.lightboxImg.src = url || '';
    els.lightboxImg.alt = photo.name;
    els.noteEditor.value = photo.note || '';
    els.photoMeta.textContent = `${escapeHTML(photo.name)} · ${formatSize(photo.size)} · ${formatDate(photo.created_at)}`;
    els.lightboxPrev.style.visibility = state.lightboxIndex > 0 ? 'visible' : 'hidden';
    els.lightboxNext.style.visibility = state.lightboxIndex < state.photos.length - 1 ? 'visible' : 'hidden';

    // 动态照片：展示视频与切换按钮
    const motionUrl = Storage.getMotionVideoUrl(photo);
    const isMotion = !!motionUrl;
    els.motionBadge.hidden = !isMotion;
    els.motionToggle.hidden = !isMotion;
    if (isMotion) {
        els.lightboxVideo.src = motionUrl;
        els.lightboxVideo.hidden = true;     // 默认显示静态图，点击按钮再播放
        els.motionToggle.textContent = '▶';
        els.motionToggle.dataset.playing = '0';
    } else {
        els.lightboxVideo.removeAttribute('src');
        els.lightboxVideo.hidden = true;
    }
}

function toggleMotion() {
    const playing = els.motionToggle.dataset.playing === '1';
    if (playing) {
        els.lightboxVideo.pause();
        els.lightboxVideo.hidden = true;
        els.lightboxImg.hidden = false;
        els.motionToggle.textContent = '▶';
        els.motionToggle.dataset.playing = '0';
    } else {
        els.lightboxImg.hidden = true;
        els.lightboxVideo.hidden = false;
        els.lightboxVideo.currentTime = 0;
        els.lightboxVideo.play().catch(() => {});
        els.motionToggle.textContent = '⏸';
        els.motionToggle.dataset.playing = '1';
    }
}

let lastNoteIdx = -1;
async function saveNoteIfNeeded() {
    if (state.lightboxIndex < 0) return;
    const photo = state.photos[state.lightboxIndex];
    if (!photo) return;
    const newNote = els.noteEditor.value;
    if (newNote === (photo.note || '')) return;

    try {
        await Storage.updatePhoto(photo.id, { note: newNote });
        photo.note = newNote;
        // 仅更新对应卡片的备注徽标，避免重新拉取/渲染整张网格
        updatePhotoCardNote(state.lightboxIndex, newNote);
    } catch (e) {
        console.error(e);
        toast('备注保存失败', 'error');
    }
}

/** 局部更新单张照片卡片的备注显示，避免全量重渲染 */
function updatePhotoCardNote(idx, note) {
    const card = els.photoGrid.querySelector(`.photo-card[data-index="${idx}"]`);
    if (!card) return;
    let badge = card.querySelector('.photo-note-badge');
    let overlay = card.querySelector('.photo-overlay');
    if (note) {
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'photo-note-badge';
            card.appendChild(badge);
        }
        badge.textContent = '📝';
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'photo-overlay';
            const text = document.createElement('div');
            text.className = 'photo-note-text';
            overlay.appendChild(text);
            card.appendChild(overlay);
        }
        overlay.querySelector('.photo-note-text').textContent = note;
    } else {
        if (badge) badge.remove();
        if (overlay) overlay.remove();
    }
}

function navigateLightbox(delta) {
    const next = state.lightboxIndex + delta;
    if (next < 0 || next >= state.photos.length) return;
    saveNoteIfNeeded();
    // 切换前停止当前动态视频
    if (els.lightboxVideo && !els.lightboxVideo.hidden) {
        els.lightboxVideo.pause();
    }
    els.lightboxImg.hidden = false;
    state.lightboxIndex = next;
    renderLightbox();
}

function deleteCurrentPhoto() {
    const photo = state.photos[state.lightboxIndex];
    if (!photo) return;
    showConfirm({
        title: '删除照片',
        text: `确定要删除「${photo.name}」吗？此操作无法恢复。`,
        okText: '删除',
        onOk: async () => {
            try {
                await Storage.deletePhoto(photo.id);
                const removedIdx = state.lightboxIndex;
                state.photos.splice(removedIdx, 1);
                // 局部移除卡片，不重新拉取整页
                const card = els.photoGrid.querySelector(`.photo-card[data-index="${removedIdx}"]`);
                if (card) card.remove();
                // 重新编号后续卡片的 data-index
                els.photoGrid.querySelectorAll('.photo-card').forEach(c => {
                    const i = parseInt(c.dataset.index, 10);
                    if (i > removedIdx) c.dataset.index = String(i - 1);
                });
                els.photoCount.textContent = `${state.photos.length} 张照片`;
                if (state.photos.length === 0) {
                    els.photosEmpty.hidden = false;
                    closeLightbox();
                } else {
                    state.lightboxIndex = Math.min(state.lightboxIndex, state.photos.length - 1);
                    renderLightbox();
                }
                toast('照片已删除', 'success');
            } catch (e) {
                console.error(e);
                toast('删除失败：' + e.message, 'error');
            }
        },
    });
}

// =====================================================
// 事件绑定
// =====================================================
function bindEvents() {
    // 顶部导航
    els.backBtn.addEventListener('click', showAlbumsView);
    els.newAlbumBtn.addEventListener('click', openCreateAlbumModal);
    els.uploadBtn.addEventListener('click', openUploadModal);
    els.logoutBtn.addEventListener('click', handleLogout);

    // 密码验证
    els.authSubmit.addEventListener('click', handleAuth);
    els.authInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleAuth();
        }
    });

    // 相册卡片
    els.albumGrid.addEventListener('click', (e) => {
        const actionBtn = e.target.closest('[data-action]');
        if (actionBtn) {
            e.stopPropagation();
            const id = actionBtn.dataset.id;
            if (actionBtn.dataset.action === 'edit') openEditAlbumModal(id);
            else if (actionBtn.dataset.action === 'delete') deleteAlbum(id);
            return;
        }
        const card = e.target.closest('.album-card');
        if (card) {
            const album = state.albums.find(a => a.id === card.dataset.id);
            if (album) showPhotosView(album);
        }
    });

    // 照片卡片
    els.photoGrid.addEventListener('click', (e) => {
        const card = e.target.closest('.photo-card');
        if (card) openLightbox(parseInt(card.dataset.index, 10));
    });

    // 相册模态框
    els.albumCancelBtn.addEventListener('click', () => closeModal(els.albumModal));
    els.albumSaveBtn.addEventListener('click', saveAlbum);
    els.albumNameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') saveAlbum();
    });

    // 上传模态框
    els.uploadZone.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', (e) => {
        handleFiles(Array.from(e.target.files));
        e.target.value = '';
    });
    els.uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        els.uploadZone.classList.add('dragover');
    });
    els.uploadZone.addEventListener('dragleave', () => {
        els.uploadZone.classList.remove('dragover');
    });
    els.uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        els.uploadZone.classList.remove('dragover');
        handleFiles(Array.from(e.dataTransfer.files));
    });
    els.uploadCancelBtn.addEventListener('click', () => {
        state.pendingFiles = [];
        closeModal(els.uploadModal);
    });
    els.uploadConfirmBtn.addEventListener('click', confirmUpload);
    els.uploadPreview.addEventListener('click', (e) => {
        const btn = e.target.closest('.upload-thumb-remove');
        if (btn) {
            const idx = parseInt(btn.dataset.idx, 10);
            state.pendingFiles.splice(idx, 1);
            renderUploadPreview();
        }
    });

    // 确认对话框
    els.confirmCancelBtn.addEventListener('click', () => {
        closeModal(els.confirmModal);
        state.confirmCallback = null;
    });
    els.confirmOkBtn.addEventListener('click', () => {
        closeModal(els.confirmModal);
        const cb = state.confirmCallback;
        state.confirmCallback = null;
        if (cb) cb();
    });

    // 大图查看器
    els.lightboxClose.addEventListener('click', closeLightbox);
    els.lightboxPrev.addEventListener('click', () => navigateLightbox(-1));
    els.lightboxNext.addEventListener('click', () => navigateLightbox(1));
    els.deletePhotoBtn.addEventListener('click', deleteCurrentPhoto);
    els.motionToggle.addEventListener('click', toggleMotion);
    els.lightbox.addEventListener('click', (e) => {
        if (e.target === els.lightbox) closeLightbox();
    });
    els.noteEditor.addEventListener('blur', saveNoteIfNeeded);

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
        if (!els.lightbox.classList.contains('active')) {
            // ESC 关闭模态框
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
            }
            return;
        }
        // 大图查看器中的快捷键
        if (e.key === 'ArrowLeft') navigateLightbox(-1);
        else if (e.key === 'ArrowRight') navigateLightbox(1);
        else if (e.key === 'Escape') closeLightbox();
    });

    // 点击模态框背景关闭
    [els.albumModal, els.uploadModal, els.confirmModal].forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('active');
        });
    });
}

// =====================================================
// 密码验证
// =====================================================
function showAuthOverlay(message = '') {
    els.authOverlay.classList.remove('hidden');
    els.authOverlay.classList.add('active');
    els.authSubmit.disabled = false;
    els.authSubmit.textContent = '进入';
    els.authInput.value = '';
    els.authInput.focus();
    if (message) {
        els.authError.textContent = message;
        els.authError.classList.add('show');
    } else {
        els.authError.textContent = '';
        els.authError.classList.remove('show');
    }
    els.authLoading.textContent = '';
}

function hideAuthOverlay() {
    els.authOverlay.classList.remove('active');
    setTimeout(() => els.authOverlay.classList.add('hidden'), 400);
}

function showAuthError(msg) {
    els.authError.textContent = msg;
    els.authError.classList.add('show');
    els.authBox = document.querySelector('.auth-box');
    if (els.authBox) {
        els.authBox.classList.remove('shake');
        void els.authBox.offsetWidth; // 触发重绘
        els.authBox.classList.add('shake');
    }
    els.authInput.value = '';
    els.authInput.focus();
}

async function handleAuth() {
    const password = els.authInput.value;
    if (!password) {
        showAuthError('请输入密码');
        return;
    }
    els.authSubmit.disabled = true;
    els.authSubmit.textContent = '验证中...';
    els.authLoading.textContent = '';
    els.authError.classList.remove('show');

    try {
        await Auth.signIn(password);
        // 登录成功
        hideAuthOverlay();
        await showApp();
        toast('登录成功', 'success');
    } catch (e) {
        console.warn('Auth failed:', e.message);
        let msg = '密码错误';
        if (e.message && e.message.includes('Email not confirmed')) {
            msg = '账号未激活，请在 Supabase 控制台勾选 Auto Confirm User';
        } else if (e.message && e.message.includes('Invalid login')) {
            msg = '密码错误';
        } else if (e.message && (e.message.includes('Failed to fetch') || e.message.includes('network'))) {
            msg = '网络连接失败，请检查 Supabase 配置';
        } else if (e.message) {
            msg = e.message;
        }
        showAuthError(msg);
    } finally {
        els.authSubmit.disabled = false;
        els.authSubmit.textContent = '进入';
    }
}

async function handleLogout() {
    showConfirm({
        title: '退出登录',
        text: '确定要退出吗？下次访问需要重新输入密码。',
        okText: '退出',
        onOk: async () => {
            try {
                await Auth.signOut();
                // 重置应用状态
                state.albums = [];
                state.photos = [];
                state.currentAlbum = null;
                els.photoGrid.innerHTML = '';
                els.albumGrid.innerHTML = '';
                els.logoutBtn.hidden = true;
                els.uploadBtn.hidden = true;
                els.newAlbumBtn.hidden = true;
                els.backBtn.hidden = true;
                showAuthOverlay();
                toast('已退出登录');
            } catch (e) {
                console.error(e);
                toast('退出失败', 'error');
            }
        },
    });
}

async function showApp() {
    els.logoutBtn.hidden = false;
    els.newAlbumBtn.hidden = false;
    showAlbumsView();
}

// =====================================================
// 启动
// =====================================================
async function init() {
    bindEvents();

    // 检查登录状态
    els.authOverlay.classList.remove('hidden');
    try {
        const session = await Auth.getSession();
        if (session) {
            // 已登录，直接进入应用
            hideAuthOverlay();
            await showApp();
            return;
        }
    } catch (e) {
        console.warn('Session check failed:', e);
    }
    // 未登录，显示密码层
    showAuthOverlay();
}

document.addEventListener('DOMContentLoaded', init);
