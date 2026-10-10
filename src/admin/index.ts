/**
 * 管理端 handler 桶文件。
 *
 * 对外导出面与原 `src/admin.ts` **完全一致**（38 个 handler + CbCheckinSummary 类型），
 * 这里用显式具名 re-export 固定住这个面，避免各域文件里的内部工具意外泄漏成公共 API。
 *
 * 各域实现：
 *   common            入参归一化 / 渠道脱敏 / 上游响应归一化（内部共用）
 *   providers         系统状态 + 渠道 CRUD + Key 增量维护
 *   testing           连通性测试（Key / 模型 / OAuth 凭据）
 *   oauth             OAuth 反代渠道授权 + Vertex / Devin 凭据校验
 *   antigravity       Antigravity 授权 / 模型 / 账号 / 额度
 *   deepseek-account  DeepSeek 账号托管（代登录）
 *   checkin           CodeBuddy 批量签到 + 定时入口
 *   codebuddy / cline 账号状态与额度
 *   proxy-keys        转发令牌
 *   usage / tts       用量统计 / Azure TTS 试听
 */

export { defaultModelAlias } from './common'

export {
  handleStatus,
  handleGetProviders,
  handleListProviderKeys,
  handleUpdateProviderKeys,
  handleCreateProvider,
  handleUpdateProvider,
  handleDeleteProvider,
  handleProviderPanel,
} from './providers'

export { handleSaveDsAccount, handleDsLogin, handleClearDsAccount } from './deepseek-account'

export { handleTestModel, handleTestKeyNew, handleTestModelNew } from './testing'

export {
  handleAntigravityOAuthStart,
  handleAntigravityOAuthComplete,
  handleAntigravityModels,
  handleAntigravityAccounts,
  handleAntigravityQuotaAll,
} from './antigravity'

export {
  handleOAuthStart,
  handleOAuthComplete,
  handleOAuthPoll,
  handleOAuthModels,
  handleVertexVerify,
  handleDevinOAuthStart,
  handleDevinOAuthComplete,
  handleDevinVerify,
} from './oauth'

export { runCodebuddyCheckinAll, handleCronCheckin, handleCodebuddyCheckin } from './checkin'
export type { CbCheckinSummary } from './checkin'

export { handleCodebuddyStatus } from './codebuddy'
export { handleClineQuota } from './cline'

export {
  handleGetProxyKeys,
  handleCreateProxyKey,
  handleUpdateProxyKey,
  handleDeleteProxyKey,
} from './proxy-keys'

export { handleGetUsage } from './usage'
export { handleTtsPreview } from './tts'
