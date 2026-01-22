import Database from 'better-sqlite3'
import { join } from 'path'
import ExcelJS from 'exceljs'

const dbPath = join(process.cwd(), 'points.db')
let db: Database.Database | null = null

export interface WalletRecord {
  id: number
  address: string
  points: number | null
  last_checked: string
  status: 'success' | 'error' | 'empty_balance' | 'pending'
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface WalletStats {
  total: number
  withPoints: number
  withoutPoints: number
  errors: number
  totalPoints: number
  averagePoints: number
}

/**
 * Инициализирует базу данных и создает таблицы
 */
export function initDatabase (): void {
  try {
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')

    // Создаем таблицу wallets
    db.exec(`
      CREATE TABLE IF NOT EXISTS wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL UNIQUE,
        points INTEGER,
        last_checked DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'pending',
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_address ON wallets(address);
      CREATE INDEX IF NOT EXISTS idx_last_checked ON wallets(last_checked);
      CREATE INDEX IF NOT EXISTS idx_status ON wallets(status);
    `)
  } catch (error) {
    console.error('❌ Ошибка при инициализации базы данных:', error instanceof Error ? error.message : 'Неизвестная ошибка')
    throw error
  }
}

/**
 * Получает информацию о кошельке по адресу
 */
export function getWalletByAddress (address: string): WalletRecord | null {
  if (!db) {
    throw new Error('База данных не инициализирована')
  }

  try {
    const stmt = db.prepare('SELECT * FROM wallets WHERE address = ?')
    const result = stmt.get(address) as WalletRecord | undefined
    return result || null
  } catch (error) {
    console.error('❌ Ошибка при получении данных кошелька:', error instanceof Error ? error.message : 'Неизвестная ошибка')
    return null
  }
}

/**
 * Проверяет, нужно ли пропустить кошелек (уже успешно обработан с поинтами)
 */
export function shouldSkipWallet (address: string): boolean {
  const wallet = getWalletByAddress(address)
  if (!wallet) {
    return false
  }
  // Пропускаем только успешные кошельки с поинтами
  return wallet.status === 'success' && wallet.points !== null && wallet.points > 0
}

/**
 * Сохраняет или обновляет данные кошелька
 */
export function saveWalletData (
  address: string,
  points: number | null,
  status: 'success' | 'error' | 'empty_balance',
  errorMessage?: string
): void {
  if (!db) {
    throw new Error('База данных не инициализирована')
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO wallets (address, points, status, error_message, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(address) DO UPDATE SET
        points = excluded.points,
        status = excluded.status,
        error_message = excluded.error_message,
        last_checked = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `)
    stmt.run(address, points, status, errorMessage || null)
  } catch (error) {
    console.error('❌ Ошибка при сохранении данных кошелька:', error instanceof Error ? error.message : 'Неизвестная ошибка')
  }
}

/**
 * Получает все записи о кошельках
 */
export function getAllWallets (): WalletRecord[] {
  if (!db) {
    throw new Error('База данных не инициализирована')
  }

  try {
    const stmt = db.prepare('SELECT * FROM wallets ORDER BY last_checked DESC')
    return stmt.all() as WalletRecord[]
  } catch (error) {
    console.error('❌ Ошибка при получении данных:', error instanceof Error ? error.message : 'Неизвестная ошибка')
    return []
  }
}

/**
 * Получает статистику по кошелькам
 */
export function getWalletStats (): WalletStats {
  if (!db) {
    throw new Error('База данных не инициализирована')
  }

  try {
    const allWallets = getAllWallets()
    const total = allWallets.length
    const withPoints = allWallets.filter(w => w.status === 'success' && w.points !== null && w.points > 0).length
    const withoutPoints = allWallets.filter(w => w.status === 'empty_balance' || (w.status === 'success' && (w.points === null || w.points === 0))).length
    const errors = allWallets.filter(w => w.status === 'error').length

    const walletsWithPoints = allWallets.filter(w => w.points !== null && w.points > 0)
    const totalPoints = walletsWithPoints.reduce((sum, w) => sum + (w.points || 0), 0)
    const averagePoints = walletsWithPoints.length > 0 ? Math.round(totalPoints / walletsWithPoints.length) : 0

    return {
      total,
      withPoints,
      withoutPoints,
      errors,
      totalPoints,
      averagePoints
    }
  } catch (error) {
    console.error('❌ Ошибка при получении статистики:', error instanceof Error ? error.message : 'Неизвестная ошибка')
    return {
      total: 0,
      withPoints: 0,
      withoutPoints: 0,
      errors: 0,
      totalPoints: 0,
      averagePoints: 0
    }
  }
}

/**
 * Экспортирует данные в Excel файл
 */
export async function exportToExcel (filePath: string): Promise<void> {
  if (!db) {
    throw new Error('База данных не инициализирована')
  }

  try {
    const wallets = getAllWallets()
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Кошельки')

    // Заголовки
    worksheet.columns = [
      { header: 'Адрес', key: 'address', width: 45 },
      { header: 'Поинты', key: 'points', width: 15 },
      { header: 'Статус', key: 'status', width: 20 },
      { header: 'Сообщение об ошибке', key: 'error_message', width: 40 },
      { header: 'Дата проверки', key: 'last_checked', width: 20 }
    ]

    // Стиль заголовков
    worksheet.getRow(1).font = { bold: true }
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    }

    // Данные
    wallets.forEach(wallet => {
      const statusText = wallet.status === 'success' ? 'Успешно' : wallet.status === 'empty_balance' ? 'Пустой баланс' : 'Ошибка'
      const pointsValue = wallet.points !== null ? wallet.points : '-'
      const errorMessage = wallet.error_message || '-'

      worksheet.addRow({
        address: wallet.address,
        points: pointsValue,
        status: statusText,
        error_message: errorMessage,
        last_checked: wallet.last_checked
      })
    })

    // Форматирование колонки с поинтами
    worksheet.getColumn('points').numFmt = '#,##0'

    await workbook.xlsx.writeFile(filePath)
  } catch (error) {
    throw new Error(`Ошибка при экспорте в Excel: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
  }
}

/**
 * Закрывает соединение с базой данных
 */
export function closeDatabase (): void {
  if (db) {
    db.close()
    db = null
  }
}
