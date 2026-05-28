# Canvas ECS Game MVP

这是一个基于 **TypeScript + React + Canvas** 的组件式游戏原型。项目重点不是完整玩法，而是验证一套可持续扩展的游戏架构：

- 用 JSONC 定义实体、物品、效果等原型数据。
- 用组件组合表达能力，而不是用继承层级表达类型。
- 用系统处理组件行为，避免规则散落在 UI 或指令里。
- 用数据校验保护配置和运行时约定。

## 快速开始

```bash
npm install
npm run dev
npm run validate:data
npm run build
```

常用脚本：

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动 Vite 开发服务 |
| `npm run validate:data` | 校验 JSONC 数据、schema 和跨文件引用 |
| `npm run build` | 先校验数据，再 TypeScript 编译并构建 |
| `npm run preview` | 预览构建结果 |

## 文档入口

当前文档保持精简，重点帮助后续开发快速定位职责边界，避免多套实现方式混用。

| 文档 | 内容 |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | 架构理念、职责划分、修改定位、开发约束 |
| [`docs/data.md`](docs/data.md) | 数据文件职责、组件配置原则、schema 与运行时字段边界 |
| [`docs/roadmap.md`](docs/roadmap.md) | 当前状态、已完成能力、限制与后续方向 |

## 主要目录

```text
src/App.tsx                    # React UI、Canvas 绘制、输入交互
src/gameEngine.ts              # 对 UI 暴露的游戏引擎聚合出口
src/game/                      # World、Runtime、Systems、Commands
src/game/system/               # 各游戏系统和系统内部辅助模块
src/domain/                    # 组件 schema 与由 schema 推导的类型
*.jsonc                        # 游戏数据：effect / item / entity
tools/validate-data.ts         # 数据校验脚本
```

## 架构原则摘要

1. **数据决定能力**：物品、实体、效果优先通过组件数据表达。
2. **系统处理行为**：新增玩法优先新增或扩展 system，不把规则写进 UI。
3. **World 保存状态**：实体、物品、日志、碰撞、背包等公共状态由 `World` 管理。
4. **事件连接系统**：物品激活后的效果、伤害、传送、生成、投射物等通过事件分发扩展。
5. **schema 是契约**：新增组件字段必须同步更新 schema、类型和校验。

详细约束见 [`docs/architecture.md`](docs/architecture.md)。
