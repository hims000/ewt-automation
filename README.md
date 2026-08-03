# EWT Automation

升学E网通自动化刷课脚本（Playwright + GitHub Actions）

## 使用方式

### 1. 创建 GitHub 仓库
将本项目代码推送到你的 GitHub 仓库。

### 2. 配置 Secrets
进入仓库 Settings -> Secrets and variables -> Actions -> New repository secret，添加：

- `EWT_USER`: 你的升学E网通账号
- `EWT_PASS`: 你的升学E网通密码

### 3. 手动触发运行
进入 Actions 页面，选择 "EWT Automation"，点击 "Run workflow"。

### 4. 查看结果
运行完成后可在 Artifacts 中下载调试截图（仅失败时上传）。

## 本地测试

```bash
npm install
npx playwright install chromium
EWT_USER=账号 EWT_PASS=密码 npm start
```

## 文件结构

```
.
├── .github/workflows/ewt-automation.yml   # GitHub Actions 工作流
├── src/ewt-automation.js                  # 主脚本
├── package.json                           # 依赖配置
└── screenshots/                           # 运行截图（自动创建）
```
