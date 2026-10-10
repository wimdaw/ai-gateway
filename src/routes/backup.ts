/**
 * 备份 / 恢复 + Telegram 备份路由。
 */
import type { Hono } from 'hono'
import type { Env } from '../types'
import {
  handleBackupExport,
  handleBackupImport,
  handleBackupToR2,
  handleBackupList,
  handleBackupRestore,
  handleBackupDelete,
  handleTelegramTest,
  handleTelegramSave,
  handleBackupToTelegram,
} from '../backup'

export function registerBackupRoutes(app: Hono<{ Bindings: Env }>) {
  // ===== 备份/恢复 =====
  app.get('/admin/api/backup/export', handleBackupExport)
  app.post('/admin/api/backup/import', handleBackupImport)
  app.post('/admin/api/backup/to-r2', handleBackupToR2)
  app.get('/admin/api/backup/list', handleBackupList)
  app.post('/admin/api/backup/restore', handleBackupRestore)
  app.post('/admin/api/backup/delete', handleBackupDelete)
  // Telegram 备份
  app.post('/admin/api/telegram/test', handleTelegramTest)
  app.post('/admin/api/telegram/save', handleTelegramSave)
}

/**
 * 备份到 Telegram。
 *
 * 单独一个注册函数：原实现把它挂在 ds-probe 之后（见 routes/diagnostics.ts），
 * 为了保持路由表逐条一致，这里只把注册动作拆出来，位置仍由调用方决定。
 */
export function registerBackupToTelegramRoute(app: Hono<{ Bindings: Env }>) {
  app.post('/admin/api/backup/to-telegram', handleBackupToTelegram)
}
