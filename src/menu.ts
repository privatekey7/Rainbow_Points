#!/usr/bin/env node

import prompts from 'prompts'
import { setupEncoding } from './encoding-setup.js'
import { importWallet, loadPrivateKeys, getAddressFromPrivateKey } from './rainbow.js'
import { initDatabase, getAllWallets, getWalletStats, exportToExcel } from './database.js'
import { join } from 'path'

/**
 * Главное меню приложения
 */
async function showMenu (): Promise<void> {
  setupEncoding()

  while (true) {
    console.log('\n' + '='.repeat(50))
    console.log('Rainbow Points')
    console.log('='.repeat(50) + '\n')

    const response = await prompts({
      type: 'select',
      name: 'action',
      message: 'Выберите действие:',
      choices: [
        { title: '1. Запустить', value: 'start' },
        { title: '2. Статистика', value: 'stats' },
        { title: '3. Выход', value: 'exit' }
      ],
      initial: 0
    })

    if (!response.action) {
      // Пользователь отменил выбор (Ctrl+C)
      console.log('\n👋 До свидания!')
      process.exit(0)
    }

    switch (response.action) {
    case 'start': {
      console.log('\n🚀 Запуск обработки кошельков...\n')

      try {
        await importWallet()
      } catch (error) {
        console.error('\n❌ Ошибка при выполнении:', error instanceof Error ? error.message : 'Неизвестная ошибка')
      }
      console.log('\n⏸️  Обработка завершена. Возврат в меню...')
      break
    }

    case 'stats': {
      await showStatistics()
      break
    }

    case 'exit': {
      console.log('\n👋 До свидания!')
      process.exit(0)
      break
    }

    default: {
      console.log('\n⚠️  Неизвестное действие')
      break
    }
    }
  }
}

/**
 * Запуск приложения с меню
 */
export async function startApp (): Promise<void> {
  await showMenu()
}

// Запуск программы
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('menu.js')) {
  startApp().catch(error => {
    console.error('Критическая ошибка:', error)
    process.exit(1)
  })
}

/**
 * Показывает статистику по кошелькам
 */
async function showStatistics (): Promise<void> {
  try {
    // Инициализируем БД
    initDatabase()

    const stats = getWalletStats()
    let wallets = getAllWallets()

    if (wallets.length === 0) {
      console.log('\n📊 База данных пуста. Сначала обработайте кошельки.')
      return
    }

    // Сортируем кошельки по порядку в keys.txt
    try {
      const privateKeys = await loadPrivateKeys()
      if (privateKeys.length > 0) {
        // Создаем Map: адрес -> порядковый номер в keys.txt
        const addressOrder = new Map<string, number>()
        privateKeys.forEach((key, index) => {
          const address = getAddressFromPrivateKey(key)
          addressOrder.set(address.toLowerCase(), index)
        })

        // Сортируем кошельки по порядку в keys.txt
        wallets.sort((a, b) => {
          const orderA = addressOrder.get(a.address.toLowerCase())
          const orderB = addressOrder.get(b.address.toLowerCase())

          // Если оба адреса найдены в keys.txt, сортируем по порядку
          if (orderA !== undefined && orderB !== undefined) {
            return orderA - orderB
          }
          // Если только один найден, он идет первым
          if (orderA !== undefined) return -1
          if (orderB !== undefined) return 1
          // Если оба не найдены, сохраняем текущий порядок
          return 0
        })
      }
    } catch {
      // Если не удалось загрузить ключи (например, зашифрованы), используем текущий порядок
    }

    // Краткая статистика
    console.log('\n' + '='.repeat(60))
    console.log('Статистика поинтов')
    console.log('='.repeat(60))
    console.log(`Всего кошельков:        ${stats.total}`)
    console.log(`С поинтами:             ${stats.withPoints} (${stats.total > 0 ? Math.round((stats.withPoints / stats.total) * 100) : 0}%)`)
    console.log(`Без поинтов:            ${stats.withoutPoints} (${stats.total > 0 ? Math.round((stats.withoutPoints / stats.total) * 100) : 0}%)`)
    console.log(`Ошибки:                 ${stats.errors} (${stats.total > 0 ? Math.round((stats.errors / stats.total) * 100) : 0}%)`)
    console.log('─'.repeat(60))
    console.log(`Общая сумма поинтов:    ${stats.totalPoints.toLocaleString('ru-RU')}`)
    console.log(`Среднее на кошелек:     ${stats.averagePoints.toLocaleString('ru-RU')}`)
    console.log('='.repeat(60))

    // Детальная таблица
    console.log('\nДетальная таблица:')
    const col0Width = 6  // Нумерация
    const col1Width = 44 // Полный адрес (0x + 40 символов)
    const col2Width = 12 // Поинты
    const col3Width = 20 // Статус

    console.log('┌' + '─'.repeat(col0Width) + '┬' + '─'.repeat(col1Width) + '┬' + '─'.repeat(col2Width) + '┬' + '─'.repeat(col3Width) + '┐')
    console.log('│ ' + '№'.padEnd(col0Width - 2) + ' │ ' + 'Адрес'.padEnd(col1Width - 2) + ' │ ' + 'Поинты'.padEnd(col2Width - 2) + ' │ ' + 'Статус'.padEnd(col3Width - 2) + ' │')
    console.log('├' + '─'.repeat(col0Width) + '┼' + '─'.repeat(col1Width) + '┼' + '─'.repeat(col2Width) + '┼' + '─'.repeat(col3Width) + '┤')

    wallets.forEach((wallet, index) => {
      const number = (index + 1).toString()
      const address = wallet.address // Полный адрес
      const points = wallet.points !== null && wallet.points > 0 ? wallet.points.toString() : (wallet.points === 0 ? '0' : '-')
      let status = 'Ошибка'
      if (wallet.status === 'success') {
        status = 'Успешно'
      } else if (wallet.status === 'empty_balance') {
        status = 'Пустой баланс'
      } else if (wallet.status === 'error') {
        status = wallet.error_message ? `Ошибка: ${wallet.error_message.substring(0, 15)}` : 'Ошибка'
      }

      // Обрезаем статус, если он слишком длинный
      if (status.length > col3Width - 2) {
        status = status.substring(0, col3Width - 5) + '...'
      }

      console.log('│ ' + number.padEnd(col0Width - 2) + ' │ ' + address.padEnd(col1Width - 2) + ' │ ' + points.padEnd(col2Width - 2) + ' │ ' + status.padEnd(col3Width - 2) + ' │')
    })

    console.log('└' + '─'.repeat(col0Width) + '┴' + '─'.repeat(col1Width) + '┴' + '─'.repeat(col2Width) + '┴' + '─'.repeat(col3Width) + '┘')

    // Предложение экспорта
    const exportResponse = await prompts({
      type: 'confirm',
      name: 'export',
      message: 'Экспортировать данные в Excel?',
      initial: false
    })

    if (exportResponse.export) {
      const filePath = join(process.cwd(), 'points_export.xlsx')
      try {
        await exportToExcel(filePath)
        console.log(`\n✅ Данные экспортированы в: ${filePath}`)
      } catch (error) {
        console.error('\n❌ Ошибка при экспорте:', error instanceof Error ? error.message : 'Неизвестная ошибка')
      }
    }
  } catch (error) {
    console.error('\n❌ Ошибка при получении статистики:', error instanceof Error ? error.message : 'Неизвестная ошибка')
  }
}

export { showMenu }
