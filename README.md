# 🌳 家脉 · 电子族谱

基于 Web 的家族谱系管理与展示系统，支持多家族管理、D3.js 可视化家族树、成员审核流程、纪念墙、迁徙地图、关系计算等功能。

---

## 📋 技术栈

| 层级 | 技术 |
|------|------|
| **后端框架** | Node.js + Express 4 |
| **数据库** | MySQL 8（mysql2 驱动 + 连接池） |
| **认证** | Token 认证（crypto 随机生成，24小时过期） + bcryptjs 密码哈希 |
| **前端** | 原生 HTML/CSS/JS + D3.js 可视化 |
| **部署** | Railway 平台（见 `railway.json`） |

依赖包：`express` `mysql2` `cors` `bcryptjs`

---

## 🧩 功能模块

### 1. 多家族认证
- **注册**：输入姓氏 + 联系方式 + 密码创建新家族，首个注册用户自动成为管理员
- **登录**：按姓氏选择族谱，输入账号密码登录
- **修改密码**：登录后可修改登录密码
- **用户昵称与头像**：支持设置昵称、上传头像（Base64 存储）

### 2. 家族树可视化
- 基于 **D3.js** 绘制树形家族谱系图
- 支持 **缩放、拖拽、平移** 画布
- 每个节点显示姓名、性别、生卒年份
- 男/女节点使用不同颜色区分
- **"我"节点** 金色标识
- **聚焦模式**：点击节点进入聚焦视图，仅显示该节点子树
- 支持展开/折叠分支
- 可导出为 **PNG 图片**

### 3. 成员管理
- 添加成员（姓名、性别、出生日期、学历、职业、地址等）
- 选择父/母节点确定家族关系
- 添加配偶信息
- 成员列表**表格展示**，支持搜索
- 已故成员标记及生平简介

### 4. 审核流程
- **普通成员**添加/编辑/删除操作提交为待审核变更
- **管理员**在审核页面审批或拒绝变更，可填写拒绝原因
- 支持"我的申请"页面查看自己的提交状态
- 状态类型：待审核、已通过、已拒绝、已取消

### 5. 纪念墙
- 展示已故成员列表（卡片式布局）
- 显示姓名、生卒日期、世代、蜡烛动画
- 支持为已故成员编辑纪念信息、上传纪念照片
- 照片查看器（左右翻页浏览）

### 6. 家族大事记
- 每条事件包含标题、日期、详细描述
- 普通成员提交需审核，管理员直接生效
- 以时间线形式展示在首页

### 7. 迁徙地图
- 在地图上标记家族成员的出生地、居住地
- 可视化展示家族迁徙路径

### 8. 关系计算器
- 选择两个成员，自动计算亲缘关系
- 输出关系称呼（如"祖父"、"堂兄"、"侄子"等）

### 9. 成就系统
- 自动追踪家族数据里程碑
- 首页展示成就进度条和已解锁成就

### 10. 家族资料
- 族规展示
- 字辈排行表
- 族谱数据 **JSON 导入/导出**（备份与迁移）

### 11. 权限控制
- **管理员**：审核变更、添加用户、重置家族数据、管理大事记
- **普通成员**：提交变更申请、查看家族树和成员列表

---

## 🗄️ 数据库设计简介

MySQL 数据库名为 `family_tree`，共 6 张表：

| 表名 | 说明 | 关键字段 |
|------|------|---------|
| `families` | 家族表 | `id`, `surname`(唯一) |
| `users` | 用户表 | `family_id`(FK), `contact`, `password_hash`, `is_admin`, `nickname`, `avatar` |
| `family_tree` | 族谱数据 | `family_id`(FK,唯一), `tree_data`(JSON) |
| `pending_changes` | 待审核变更 | `family_id`(FK), `change_data`(JSON), `status`(ENUM), `submitted_by`, `reviewed_by`, `review_reason` |
| `operation_logs` | 操作日志 | `family_id`(FK), `log_data`(JSON) |
| `timeline_events` | 家族大事记 | `family_id`(FK), `event_data`(JSON) |

- 采用 `utf8mb4` 字符集支持中文
- 外键约束 `ON DELETE CASCADE`
- 族谱核心数据以 **JSON 格式**存储，灵活支持动态树结构
- 服务启动时 **自动建库建表**（无需手动执行 SQL）

---

## 🔌 API 接口概览

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | `/api/auth/register` | 否 | 注册家族 |
| POST | `/api/auth/login` | 否 | 登录 |
| POST | `/api/auth/logout` | 是 | 登出 |
| POST | `/api/change-password` | 是 | 修改密码 |
| GET | `/api/user/profile` | 是 | 获取用户资料 |
| PUT | `/api/user/profile` | 是 | 更新昵称/头像 |
| GET | `/api/tree` | 是 | 获取族谱数据 |
| PUT | `/api/tree` | 是 | 保存族谱数据 |
| GET | `/api/pending` | 是 | 获取待审核变更 |
| PUT | `/api/pending` | 是 | 提交/更新待审核变更 |
| POST | `/api/users/upsert` | 是（管理员） | 添加/更新用户 |
| GET | `/api/logs` | 是 | 获取操作日志 |
| POST | `/api/logs` | 是 | 添加操作日志 |
| DELETE | `/api/logs/:id` | 是（管理员） | 删除日志 |
| GET | `/api/events` | 是 | 获取大事记 |
| POST | `/api/events` | 是 | 添加大事记 |
| PUT | `/api/events` | 是（管理员） | 同步大事记 |
| DELETE | `/api/events/:id` | 是（管理员） | 删除大事记 |
| POST | `/api/reset-family` | 是（管理员） | 重置家族数据 |
| GET | `/api/health` | 否 | 数据库健康检查 |

认证方式：在 HTTP Header 中携带 `Authorization: Bearer <token>`

---

## 🚀 本地部署步骤

### 前置条件
- Node.js >= 16
- MySQL 8（本地安装或 Docker）

### 1. 克隆项目
```bash
git clone https://github.com/qhsv979nvj-ops/zupu.git
cd zupu
```

### 2. 安装依赖
```bash
npm install
```

### 3. 配置环境变量
将 `.env.example` 复制为 `.env` 并修改数据库连接信息：
```env
MYSQLHOST=localhost
MYSQLPORT=3306
MYSQLUSER=root
MYSQLPASSWORD=你的MySQL密码
MYSQLDATABASE=family_tree
PORT=5500
```

### 4. 启动服务
```bash
npm start
```
服务启动后将自动连接 MySQL 并创建数据库和表结构。

### 5. 访问
浏览器打开 `http://localhost:5500`

---

## 🔐 环境变量配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `MYSQLHOST` | MySQL 主机地址 | `localhost` |
| `MYSQLPORT` | MySQL 端口 | `3306` |
| `MYSQLUSER` | MySQL 用户名 | `root` |
| `MYSQLPASSWORD` | MySQL 密码 | `123456` |
| `MYSQLDATABASE` | 数据库名 | `family_tree` |
| `PORT` | 服务端口 | `5500` |

兼容 Railway 平台变量名（`DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`）。

---

## 📸 项目截图位置

在项目运行后，可通过浏览器访问以下页面截图：

| 页面 | 访问方式 |
|------|---------|
| 登录/注册页 | 启动后默认页面 |
| 家族首页 | 登录后首页 Tab |
| 家族树 | 导航栏"家族树" |
| 成员列表 | 导航栏"成员列表" |
| 审核管理 | 导航栏"审核"（管理员可见） |
| 纪念墙 | 导航栏"纪念墙" |
| 迁徙地图 | 导航栏"迁徙地图" |
| 关系计算器 | 导航栏"关系计算" |
| 家族资料 | 导航栏"家族资料" |

---

## 📝 开发总结

### 架构特点
- **单文件前端**：所有页面逻辑集中在 `zupu.html`（约 7900 行），采用 `display:none/flex` 切换页面，无需前端路由框架
- **JSON 树结构**：族谱数据以嵌套 JSON 存储，每个节点包含 `name`、`gender`、`birth`、`children[]`、`spouses[]` 等字段
- **Token 内存存储**：用户会话存储在服务端 `Map` 中，24 小时自动过期
- **自动建表**：服务启动时通过 `CREATE TABLE IF NOT EXISTS` 自动初始化数据库

### 设计决策
- 选择 MySQL over SQLite：支持 Railway 等云平台部署，多实例共享数据库
- JSON 列存储树数据：灵活支持任意深度的家族树，无需递归查询
- 审核机制：防止未授权成员直接修改族谱数据，保持数据完整性
- 按姓氏隔离：`families` 表 + `family_id` 外键实现多家族数据隔离

### 项目结构
```
电子族谱/
├── zupu.html          # 前端 SPA 主文件（登录 + 全部功能页面）
├── index.html         # 入口重定向文件
├── server.js          # Express 后端服务
├── schema.sql         # 数据库表结构参考
├── package.json       # 项目配置与依赖
├── railway.json       # Railway 平台部署配置
├── .env.example       # 环境变量模板
├── .gitignore         # Git 忽略规则
└── 启动族谱.bat        # Windows 快速启动脚本
```
