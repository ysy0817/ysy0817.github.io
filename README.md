# 云相册 · Cloud Album

基于 Supabase + GitHub Pages 的私人云端相册。

## 功能特性

- 🔒 密码验证（基于 Supabase Auth，密码不在代码中）
- 📁 创建 / 编辑 / 删除相册
- 🖼️ 照片上传（支持 JPG / PNG / WebP / GIF，≤20MB / 张）
- 📝 为每张照片添加备注
- ↔️ 照片全屏浏览、左右切换、键盘快捷键
- 🌙 毛玻璃现代 UI 风格，响应式适配移动端

## 部署到 GitHub Pages

1. 将本仓库推送至 GitHub
2. 仓库 Settings → Pages → 选择 `main` 分支根目录
3. 访问：`https://用户名.github.io/仓库名/`

## 技术栈

- 前端：Vanilla HTML / CSS / ES Modules
- 后端：Supabase（PostgreSQL + Auth + Storage）
- 托管：GitHub Pages
