-- ==========================================================
-- 云相册 · Supabase 数据库初始化脚本
--
-- 使用方法：
-- 1. 登录 Supabase Dashboard
-- 2. 进入 SQL Editor → New Query
-- 3. 粘贴本文件全部内容并执行
-- 4. 然后在 Authentication → Users 中创建一个账号
--    （邮箱对应前端 config.js 中的 AUTH_EMAIL，密码即访问相册的密码）
-- ==========================================================

-- ---------- 1. 启用 pgcrypto（用于 gen_random_uuid） ----------
create extension if not exists pgcrypto;

-- ---------- 2. 创建相册表 ----------
create table if not exists albums (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    description text default '',
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

-- ---------- 3. 创建照片表 ----------
create table if not exists photos (
    id uuid primary key default gen_random_uuid(),
    album_id uuid references albums(id) on delete cascade,
    name text not null,
    type text,
    size bigint,
    note text default '',
    storage_path text not null,
    motion_video_path text default null,  -- 动态照片内嵌视频的存储路径（Android Motion Photo 自动提取）
    created_at timestamptz default now()
);

-- 已有库升级：若 photos 表已存在但缺少 motion_video_path 列，执行下方语句安全补列
-- （重复执行不会报错）
do $$
begin
    if not exists (
        select 1 from information_schema.columns
        where table_name = 'photos' and column_name = 'motion_video_path'
    ) then
        alter table photos add column motion_video_path text default null;
    end if;
end $$;

create index if not exists idx_photos_album_id on photos(album_id);
create index if not exists idx_photos_created_at on photos(created_at desc);
create index if not exists idx_albums_created_at on albums(created_at desc);

-- ---------- 4. 自动更新 updated_at 触发器 ----------
create or replace function update_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists albums_updated_at on albums;
create trigger albums_updated_at
    before update on albums
    for each row execute function update_updated_at();

-- ---------- 5. 启用行级安全 (RLS) ----------
alter table albums enable row level security;
alter table photos enable row level security;

-- ---------- 6. RLS 策略 ----------
-- 只有已认证用户（输入正确密码登录后）可以读写相册
drop policy if exists "albums_select_authenticated" on albums;
drop policy if exists "albums_write_authenticated" on albums;
drop policy if exists "photos_select_authenticated" on photos;
drop policy if exists "photos_write_authenticated" on photos;

create policy "albums_select_authenticated" on albums
    for select to authenticated using (true);

create policy "albums_write_authenticated" on albums
    for all to authenticated using (true) with check (true);

create policy "photos_select_authenticated" on photos
    for select to authenticated using (true);

create policy "photos_write_authenticated" on photos
    for all to authenticated using (true) with check (true);

-- ---------- 7. Storage Bucket ----------
-- 在 Dashboard → Storage 中手动创建 bucket：
--   名称：photos
--   Public bucket：✅ 勾选（公开读取，让浏览器能直接显示图片）
--
-- 然后执行以下策略（让匿名用户可读，已认证用户可写）：
--
--   公开读取策略：
--     allow select on storage.objects to public using (bucket_id = 'photos');
--
--   已认证上传策略：
--     allow insert to authenticated with check (bucket_id = 'photos');
--
--   已认证删除策略：
--     allow delete to authenticated using (bucket_id = 'photos');
--
-- 或直接在 Storage 界面的 "Policies" 中通过 UI 创建上述策略。

-- ---------- 8. 创建应用账号 ----------
-- 在 Dashboard → Authentication → Users → Add user 创建：
--   Email:    album@app.local  (对应前端 config.js 的 AUTH_EMAIL，可改)
--   Password: 你的相册访问密码（这就是登录密码，注意不会出现在代码里）
--   Auto Confirm User: ✅ 必须勾选
--
-- 完成后即可使用：前端输入该密码即登录访问相册。
