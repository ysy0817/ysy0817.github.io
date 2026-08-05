/**
 * Supabase 配置
 *
 * 使用方法：
 * 1. 注册 Supabase 免费账号：https://supabase.com
 * 2. 创建新项目，等待 2 分钟初始化完成
 * 3. 在 Dashboard → Settings → API 中复制：
 *    - Project URL  → 填入 SUPABASE_URL
 *    - anon public  → 填入 SUPABASE_ANON_KEY
 * 4. 在 Dashboard → SQL Editor 中执行仓库根目录的 schema.sql
 * 5. 在 Dashboard → Authentication → Users → Add user 创建账号：
 *    - Email:    填入下方 AUTH_EMAIL（可自定义，公开无敏感）
 *    - Password: 你的相册访问密码（不要写到代码中！）
 *    - 勾选 "Auto Confirm User"
 *
 * 安全说明：
 * - anon key 设计为可公开，配合 RLS 策略保证安全
 * - 真正的安全屏障是密码（存于 Supabase Auth，不在代码中）
 * - 此文件可以正常提交到 GitHub，无敏感信息泄露
 */

export const SUPABASE_URL = 'https://rfxmgnrkquablkakdjvt.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_QnOPQC7tcy7XKZhD4gO9GA_PI8NlF5Z';

// 应用统一账号邮箱（公开可见，无敏感性）
// 密码由你自己在 Supabase 控制台设置，绝不会出现在代码中
export const AUTH_EMAIL = 'album@app.local';
