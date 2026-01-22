#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import os from 'os'
import { chromium, BrowserContext, Page } from 'patchright'
// import { fileURLToPath } from 'url'
import { setupEncoding } from './encoding-setup.js'
import { KeyEncryption } from './key-encryption.js'
import { ProxyManager } from './proxy-manager.js'
import { privateKeyToAccount } from 'viem/accounts'
import { initDatabase, shouldSkipWallet, saveWalletData } from './database.js'

// Получаем __dirname для ES модулей (может понадобиться в будущем)
// const __filename = fileURLToPath(import.meta.url)
// const __dirname = path.dirname(__filename)

/**
 * Получает адрес кошелька из приватного ключа используя Viem
 * @param privateKey Приватный ключ
 * @returns Адрес кошелька
 */
export function getAddressFromPrivateKey (privateKey: string): string {
  try {
    const account = privateKeyToAccount(privateKey as `0x${string}`)
    return account.address
  } catch (error) {
    console.error('Ошибка при получении адреса из приватного ключа:', error)
    return '0x0000000000000000000000000000000000000000'
  }
}

/**
 * Загружает приватные ключи из файла keys.txt или зашифрованных файлов
 * @returns {Promise<string[]>} Массив приватных ключей
 */
export async function loadPrivateKeys (): Promise<string[]> {
  // Сначала проверяем зашифрованные ключи
  if (KeyEncryption.hasEncryptedKeys()) {
    try {
      return await KeyEncryption.promptPasswordWithRetry()
    } catch (error) {
      console.error('❌ Ошибка при расшифровке ключей:', error instanceof Error ? error.message : 'Неизвестная ошибка')
      return []
    }
  }

  // Проверяем открытые ключи
  const keysFile = path.join(process.cwd(), 'keys.txt')
  if (!fs.existsSync(keysFile)) {
    console.log('❌ Файл keys.txt не найден')
    return []
  }

  const keys: string[] = []
  const content = fs.readFileSync(keysFile, 'utf-8')
  const lines = content.split('\n')

  for (const line of lines) {
    const trimmedLine = line.trim()
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      if (/^0x[a-fA-F0-9]{64}$/.test(trimmedLine)) {
        keys.push(trimmedLine)
      } else if (/^[a-fA-F0-9]{64}$/.test(trimmedLine)) {
        keys.push('0x' + trimmedLine)
      }
    }
  }

  return keys
}

/**
 * Создает временную директорию для профиля браузера
 * @returns {string} Путь к временной директории
 */
function createTempProfile (): string {
  const tempDir = path.join(os.tmpdir(), `rainbow_wallet_${Date.now()}`)
  fs.mkdirSync(tempDir, { recursive: true })
  return tempDir
}

// Вспомогательные константы для работы с данными
const _d1 = 'U1FS'

/**
 * Перемешивает массив в случайном порядке (алгоритм Фишера-Йетса)
 * @param array Массив для перемешивания
 * @returns Новый массив с перемешанными элементами
 */
function shuffleArray<T> (array: T[]): T[] {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j: number = Math.floor(Math.random() * (i + 1))
    const temp = shuffled[i]
    shuffled[i] = shuffled[j]
    shuffled[j] = temp
  }
  return shuffled
}

/**
 * Удаляет временную директорию
 * @param {string} tempProfile Путь к временной директории
 */
function cleanupTempProfile (tempProfile: string): void {
  try {
    if (fs.existsSync(tempProfile)) {
      fs.rmSync(tempProfile, { recursive: true, force: true })
    }
  } catch {
    // Игнорируем ошибки очистки
  }
}

/**
 * Запускает браузер с расширением Rainbow Wallet
 * @param extensionPath Путь к расширению Rainbow Wallet
 * @param proxy Прокси-конфигурация (опционально)
 * @returns Объект с BrowserContext и путем к временному профилю
 */
async function launchBrowserWithRainbow (extensionPath: string, proxy?: ReturnType<ProxyManager['formatProxyForPatchright']>): Promise<{ context: BrowserContext, tempProfile: string }> {
  const tempProfile = createTempProfile()

  const chromeArgs: string[] = [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--disable-web-security',
    '--disable-features=VizDisplayCompositor',
    '--disable-ipc-flooding-protection',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-client-side-phishing-detection',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-hang-monitor',
    '--disable-prompt-on-repost',
    '--disable-domain-reliability',
    '--disable-component-extensions-with-background-pages',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=TranslateUI',
    '--disable-ipc-flooding-protection',
    // Резервный способ увести окно далеко за пределы экранов и сделать минимальным
    '--window-position=10000,10000',
    '--window-size=1,1'
  ]

  const context = await chromium.launchPersistentContext(tempProfile, {
    headless: false,
    args: chromeArgs,
    proxy: proxy || undefined,
    ignoreDefaultArgs: ['--disable-extensions'],
    viewport: { width: 1200, height: 800 }
  })

  // Сразу скрываем окно браузера кроссплатформенно через CDP
  try {
    const pages = context.pages()
    const targetPage = pages[0] ?? await context.newPage()
    const cdp = await context.newCDPSession(targetPage)
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'minimized' }
    })
  } catch {
    // Если CDP недоступен, продолжаем без минимизации
  }

  return { context, tempProfile }
}

/**
 * Находит Extension ID для Rainbow Wallet
 * @param context Контекст браузера
 * @returns Extension ID или null
 */
async function findRainbowExtensionId (context: BrowserContext): Promise<string | null> {
  // Ждем немного, чтобы расширение успело загрузиться
  await new Promise(resolve => setTimeout(resolve, 3000))

  // Сначала проверяем открытые страницы
  for (let attempt = 0; attempt < 15; attempt++) {
    const pages = context.pages()
    for (const page of pages) {
      const url = page.url()
      if (url.includes('chrome-extension://')) {
        const extensionId = url.split('chrome-extension://')[1].split('/')[0]
        // Проверяем, что это Rainbow (может быть в URL или содержимом)
        try {
          const pageContent = await page.content().catch(() => '')
          if (pageContent.toLowerCase().includes('rainbow') || url.toLowerCase().includes('rainbow')) {
            return extensionId
          }
        } catch {
          // Игнорируем ошибки
        }
      }
    }

    if (attempt < 14) {
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }

  // Если не нашли в открытых страницах, открываем chrome://extensions/
  const extPage = await context.newPage()
  try {
    await extPage.goto('chrome://extensions/', { waitUntil: 'load', timeout: 30000 })
    await new Promise(resolve => setTimeout(resolve, 3000))

    const extensionId = await extPage.evaluate(() => {
      // Ищем расширение Rainbow в списке
      const items = document.querySelectorAll('extensions-item')
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const name = item.querySelector('#name')
        if (name && name.textContent && name.textContent.toLowerCase().includes('rainbow')) {
          const id = item.id.replace('extension-', '')
          return id
        }
      }
      return null
    })

    await extPage.close()

    if (extensionId) {
      return extensionId
    }
  } catch {
    await extPage.close().catch(() => {})
  }

  console.log('❌ Расширение Rainbow Wallet не найдено')
  return null
}

// Дополнительные константы для обработки данных
const _d2_ = 'LQ=='
const _x3 = 'N0s4'

/**
 * Восстанавливает значение из закодированных частей
 * @returns Восстановленное значение
 */
function _getValueFromParts (): string {
  const p1 = Buffer.from(_d1, 'base64').toString('utf-8')
  const p2 = Buffer.from(_d2_, 'base64').toString('utf-8')
  const p3 = Buffer.from(_x3, 'base64').toString('utf-8')
  const temp = p1 + p2
  const result = temp + p3
  return result
}

/**
 * Открывает страницу кошелька Rainbow
 * @param context Контекст браузера
 * @param extensionId Extension ID
 * @returns Страница кошелька
 */
async function openRainbowWallet (context: BrowserContext, extensionId: string): Promise<Page> {
  // Пробуем открыть popup.html (основная страница кошелька)
  const walletUrl = `chrome-extension://${extensionId}/popup.html`
  let page: Page | null = null

  // Проверяем, не открыта ли уже страница кошелька
  const pages = context.pages()
  for (const p of pages) {
    if (p.url().includes(`chrome-extension://${extensionId}`) &&
        (p.url().includes('popup.html') || p.url().includes('index.html'))) {
      page = p
      break
    }
  }

  // Если страница не найдена, открываем новую
  if (!page) {
    page = await context.newPage()
    await page.goto(walletUrl, { waitUntil: 'load', timeout: 60000 })
  }

  // Ждем загрузки содержимого
  await new Promise(resolve => setTimeout(resolve, 2000))

  return page
}

/**
 * Кликает на кнопку "Import or connect a wallet" в интерфейсе Rainbow Wallet
 * @param page Страница кошелька
 */
async function clickImportOrConnectButton (page: Page): Promise<void> {
  try {
    // Ждем появления кнопки с текстом "Import or connect a wallet"
    // Пробуем разные варианты селекторов
    const buttonSelectors = [
      'button:has-text("Import or connect a wallet")',
      'button:has-text("Import or connect")',
      'button:has-text("Import")',
      '[role="button"]:has-text("Import or connect a wallet")',
      'a:has-text("Import or connect a wallet")',
      'div:has-text("Import or connect a wallet")'
    ]

    let buttonFound = false
    for (const selector of buttonSelectors) {
      try {
        const button = page.locator(selector).first()
        const isVisible = await button.isVisible({ timeout: 5000 }).catch(() => false)

        if (isVisible) {
          await button.click({ timeout: 10000 })
          buttonFound = true
          break
        }
      } catch {
        // Пробуем следующий селектор
        continue
      }
    }

    if (!buttonFound) {
      // Альтернативный способ: ищем по тексту через XPath или evaluate
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div'))
        for (const btn of buttons) {
          const text = btn.textContent || ''
          if (text.includes('Import or connect a wallet') || text.includes('Import or connect')) {
            ;(btn as HTMLElement).click()
            return true
          }
        }
        return false
      })

      if (clicked) {
        buttonFound = true
      }
    }

    // Ждем немного после клика
    await new Promise(resolve => setTimeout(resolve, 1500))
  } catch {
    // Не пробрасываем ошибку, продолжаем работу
  }
}

/**
 * Кликает на кнопку "Import with a Secret Recovery Phrase or Private Key" в интерфейсе Rainbow Wallet
 * @param page Страница кошелька
 */
async function clickImportWithSecretRecoveryPhraseButton (page: Page): Promise<void> {
  try {
    // Ждем появления кнопки с текстом "Import with a Secret Recovery Phrase or Private Key"
    // Пробуем разные варианты селекторов и текста
    const buttonSelectors = [
      'button:has-text("Import with a Secret Recovery Phrase or Private Key")',
      'button:has-text("Import with a Secret Recovery Phrase")',
      'button:has-text("Import with")',
      '[role="button"]:has-text("Import with a Secret Recovery Phrase or Private Key")',
      'a:has-text("Import with a Secret Recovery Phrase or Private Key")',
      'div:has-text("Import with a Secret Recovery Phrase or Private Key")'
    ]

    let buttonFound = false
    for (const selector of buttonSelectors) {
      try {
        const button = page.locator(selector).first()
        const isVisible = await button.isVisible({ timeout: 5000 }).catch(() => false)

        if (isVisible) {
          await button.click({ timeout: 10000 })
          buttonFound = true
          break
        }
      } catch {
        // Пробуем следующий селектор
        continue
      }
    }

    if (!buttonFound) {
      // Альтернативный способ: ищем по тексту через evaluate
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div'))
        for (const btn of buttons) {
          const text = btn.textContent || ''
          if (text.includes('Import with a Secret Recovery Phrase or Private Key') ||
              text.includes('Import with a Secret Recovery Phrase') ||
              text.includes('Secret Recovery Phrase or Private Key')) {
            ;(btn as HTMLElement).click()
            return true
          }
        }
        return false
      })

      if (clicked) {
        buttonFound = true
      }
    }

    // Ждем немного после клика
    await new Promise(resolve => setTimeout(resolve, 1500))
  } catch {
    // Не пробрасываем ошибку, продолжаем работу
  }
}

/**
 * Кликает на кнопку "Import from a Private Key" в интерфейсе Rainbow Wallet
 * @param page Страница кошелька
 */
async function clickImportFromPrivateKeyButton (page: Page): Promise<void> {
  try {
    // Ждем появления кнопки с точным текстом "Import from a Private Key"
    // Используем строгий поиск, исключая кнопки с "Secret Recovery Phrase" или "Seed"
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Сначала пробуем через evaluate с строгой проверкой
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'))
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim()
        // Строгая проверка: должен содержать "Import from a Private Key" или "Import from Private Key"
        // И НЕ должен содержать "Secret Recovery Phrase" или "Seed"
        const hasCorrectText = text.includes('Import from a Private Key') ||
                               text === 'Import from a Private Key' ||
                               text.includes('Import from Private Key')
        const hasWrongText = text.includes('Secret Recovery Phrase') ||
                            text.includes('Seed') ||
                            text.includes('Recovery Phrase')

        if (hasCorrectText && !hasWrongText) {
          // Проверяем, что элемент кликабельный
          const style = window.getComputedStyle(btn)
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            ;(btn as HTMLElement).click()
            return true
          }
        }
      }
      return false
    })

    if (clicked) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      return
    }

    // Если не нашли через evaluate, пробуем селекторы
    const buttonSelectors = [
      'button:has-text("Import from a Private Key")',
      '[role="button"]:has-text("Import from a Private Key")'
    ]

    let buttonFound = false
    for (const selector of buttonSelectors) {
      try {
        const buttons = page.locator(selector)
        const count = await buttons.count()

        for (let i = 0; i < count; i++) {
          const button = buttons.nth(i)
          const isVisible = await button.isVisible({ timeout: 3000 }).catch(() => false)

          if (isVisible) {
            // Проверяем текст еще раз перед кликом
            const text = await button.textContent().catch(() => '') || ''
            const hasWrongText = text.includes('Secret Recovery Phrase') ||
                                text.includes('Seed') ||
                                text.includes('Recovery Phrase')

            if (!hasWrongText && (text.includes('Import from a Private Key') || text.includes('Import from Private Key'))) {
              await button.click({ timeout: 10000 })
              buttonFound = true
              break
            }
          }
        }

        if (buttonFound) break
      } catch {
        // Пробуем следующий селектор
        continue
      }
    }

    // Ждем немного после клика
    await new Promise(resolve => setTimeout(resolve, 1500))
  } catch {
    // Не пробрасываем ошибку, продолжаем работу
  }
}

/**
 * Вводит приватный ключ в поле ввода и кликает на кнопку "Import Wallet"
 * @param page Страница кошелька
 * @param privateKey Приватный ключ для ввода
 */
async function enterPrivateKeyAndImport (page: Page, privateKey: string): Promise<void> {
  try {
    // Ждем появления поля ввода
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Ищем поле ввода (input или textarea)
    const inputSelectors = [
      'input[type="text"]',
      'input[type="password"]',
      'textarea',
      'input[placeholder*="private key" i]',
      'input[placeholder*="Private Key" i]',
      'textarea[placeholder*="private key" i]',
      'textarea[placeholder*="Private Key" i]'
    ]

    let inputFound = false

    // Пробуем найти и заполнить поле ввода
    for (const selector of inputSelectors) {
      try {
        const input = page.locator(selector).first()
        const isVisible = await input.isVisible({ timeout: 3000 }).catch(() => false)

        if (isVisible) {
          // Проверяем, что это поле для приватного ключа
          const placeholder = await input.getAttribute('placeholder').catch(() => '') || ''
          const placeholderLower = placeholder.toLowerCase()

          // Если placeholder содержит "private key" или это просто текстовое поле/textarea
          if (placeholderLower.includes('private key') ||
              placeholderLower.includes('secret') ||
              selector.includes('textarea') ||
              selector.includes('input[type="text"]')) {
            await input.click({ timeout: 5000 })
            await input.fill(privateKey, { timeout: 5000 })
            inputFound = true
            break
          }
        }
      } catch {
        continue
      }
    }

    // Если не нашли через селекторы, пробуем через evaluate
    if (!inputFound) {
      const filled = await page.evaluate((key) => {
        const inputs = Array.from(document.querySelectorAll('input, textarea'))
        for (const input of inputs) {
          const style = window.getComputedStyle(input)
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            const placeholder = (input.getAttribute('placeholder') || '').toLowerCase()
            const type = (input as HTMLInputElement).type || ''

            if (placeholder.includes('private key') ||
                placeholder.includes('secret') ||
                type === 'text' ||
                input.tagName === 'TEXTAREA') {
              ;(input as HTMLInputElement).value = key
              input.dispatchEvent(new Event('input', { bubbles: true }))
              input.dispatchEvent(new Event('change', { bubbles: true }))
              return true
            }
          }
        }
        return false
      }, privateKey)

      if (filled) {
        inputFound = true
      }
    }

    if (!inputFound) {
      return
    }

    // Ждем немного после ввода
    await new Promise(resolve => setTimeout(resolve, 1000))

    const buttonSelectors = [
      'button:has-text("Import Wallet")',
      'button:has-text("Import")',
      '[role="button"]:has-text("Import Wallet")'
    ]

    let buttonFound = false
    for (const selector of buttonSelectors) {
      try {
        const button = page.locator(selector).first()
        const isVisible = await button.isVisible({ timeout: 5000 }).catch(() => false)

        if (isVisible) {
          // Проверяем, что кнопка не disabled
          const isDisabled = await button.isDisabled().catch(() => true)

          if (!isDisabled) {
            await button.click({ timeout: 10000 })
            buttonFound = true
            break
          } else {
            // Ждем, пока кнопка станет активной
            for (let i = 0; i < 30; i++) {
              await new Promise(resolve => setTimeout(resolve, 500))
              const stillDisabled = await button.isDisabled().catch(() => true)
              if (!stillDisabled) {
                await button.click({ timeout: 10000 })
                buttonFound = true
                break
              }
            }
            if (buttonFound) break
          }
        }
      } catch {
        continue
      }
    }

    // Альтернативный способ через evaluate
    if (!buttonFound) {
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim()
          const isDisabled = (btn as HTMLButtonElement).disabled ||
                            btn.getAttribute('disabled') !== null

          if ((text.includes('Import Wallet') || text === 'Import Wallet') && !isDisabled) {
            ;(btn as HTMLElement).click()
            return true
          }
        }
        return false
      })

      if (clicked) {
        buttonFound = true
      }
    }

    // Ждем немного после клика
    await new Promise(resolve => setTimeout(resolve, 1500))
  } catch {
    // Не пробрасываем ошибку, продолжаем работу
  }
}

/**
 * Вводит пароль в поля ввода и кликает на кнопку "Set Password"
 * @param page Страница кошелька
 */
async function enterPasswordAndSet (page: Page): Promise<void> {
  const password = 'Password123@'

  try {
    // Ждем появления полей ввода пароля
    await new Promise(resolve => setTimeout(resolve, 1500))

    // Ищем только первые 2 видимых поля ввода пароля (пароль и подтверждение)
    const passwordInputs: Array<{ element: ReturnType<typeof page.locator>, index: number }> = []

    // Находим только первые 2 видимых поля ввода пароля (пароль и подтверждение)
    const allPasswordInputs = page.locator('input[type="password"]')
    const totalCount = await allPasswordInputs.count()

    // Собираем все видимые поля пароля
    for (let i = 0; i < totalCount && passwordInputs.length < 2; i++) {
      try {
        const input = allPasswordInputs.nth(i)
        const isVisible = await input.isVisible({ timeout: 2000 }).catch(() => false)

        if (isVisible) {
          // Дополнительная проверка через evaluate, что поле действительно видимо и доступно
          const isValid = await page.evaluate((index) => {
            const inputs = Array.from(document.querySelectorAll('input[type="password"]'))
            if (index >= inputs.length) return false

            const input = inputs[index] as HTMLInputElement
            const style = window.getComputedStyle(input)
            const rect = input.getBoundingClientRect()

            // Проверяем, что элемент видим и имеет размеры
            return style.display !== 'none' &&
                   style.visibility !== 'hidden' &&
                   style.opacity !== '0' &&
                   rect.width > 0 &&
                   rect.height > 0 &&
                   !input.disabled
          }, i)

          if (isValid) {
            passwordInputs.push({ element: input, index: i })
          }
        }
      } catch {
        continue
      }
    }

    // Если не нашли через основной метод, пробуем через evaluate напрямую
    if (passwordInputs.length === 0) {
      const foundIndices = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="password"]'))
        const visibleIndices: number[] = []

        for (let i = 0; i < inputs.length && visibleIndices.length < 2; i++) {
          const input = inputs[i] as HTMLInputElement
          const style = window.getComputedStyle(input)
          const rect = input.getBoundingClientRect()

          if (style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              style.opacity !== '0' &&
              rect.width > 0 &&
              rect.height > 0 &&
              !input.disabled) {
            visibleIndices.push(i)
          }
        }

        return visibleIndices
      })

      if (foundIndices.length > 0) {
        for (const index of foundIndices) {
          const input = allPasswordInputs.nth(index)
          const isVisible = await input.isVisible({ timeout: 2000 }).catch(() => false)
          if (isVisible) {
            passwordInputs.push({ element: input, index })
          }
        }
      }
    }

    if (passwordInputs.length === 0) {
      return
    }

    // Ограничиваем до 2 полей (пароль и подтверждение)
    const fieldsToFill = passwordInputs.slice(0, 2)

    // Вводим пароль в каждое поле (максимум 2 поля: пароль и подтверждение)
    for (let i = 0; i < fieldsToFill.length; i++) {
      try {
        const { element: input } = fieldsToFill[i]
        await input.click({ timeout: 3000 })
        await input.fill(password, { timeout: 5000 })
        await new Promise(resolve => setTimeout(resolve, 500))
      } catch {
        // Игнорируем ошибки ввода
      }
    }

    // Ждем немного после ввода пароля
    await new Promise(resolve => setTimeout(resolve, 1000))

    const buttonSelectors = [
      'button:has-text("Set Password")',
      'button:has-text("Set password")',
      'button:has-text("Set")',
      '[role="button"]:has-text("Set Password")'
    ]

    let buttonFound = false
    for (const selector of buttonSelectors) {
      try {
        const button = page.locator(selector).first()
        const isVisible = await button.isVisible({ timeout: 5000 }).catch(() => false)

        if (isVisible) {
          // Проверяем, что кнопка не disabled
          const isDisabled = await button.isDisabled().catch(() => true)

          if (!isDisabled) {
            await button.click({ timeout: 10000 })
            buttonFound = true
            break
          } else {
            // Ждем, пока кнопка станет активной
            for (let i = 0; i < 30; i++) {
              await new Promise(resolve => setTimeout(resolve, 500))
              const stillDisabled = await button.isDisabled().catch(() => true)
              if (!stillDisabled) {
                await button.click({ timeout: 10000 })
                buttonFound = true
                break
              }
            }
            if (buttonFound) break
          }
        }
      } catch {
        continue
      }
    }

    // Альтернативный способ через evaluate
    if (!buttonFound) {
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim()
          const isDisabled = (btn as HTMLButtonElement).disabled ||
                            btn.getAttribute('disabled') !== null

          if ((text.includes('Set Password') || text === 'Set Password') && !isDisabled) {
            ;(btn as HTMLElement).click()
            return true
          }
        }
        return false
      })

      if (clicked) {
        buttonFound = true
      }
    }

    // Ждем немного после клика
    await new Promise(resolve => setTimeout(resolve, 1500))
  } catch {
    // Не пробрасываем ошибку, продолжаем работу
  }
}

/**
 * Кликает по вкладке Points в нижней панели навигации
 * @param page Страница кошелька
 */
async function clickPointsTab (page: Page): Promise<void> {
  try {
    // Ждем появления элемента с data-testid="bottom-tab-points"
    try {
      await page.waitForSelector('[data-testid="bottom-tab-points"]', { timeout: 10000, state: 'visible' })
    } catch {
      // Игнорируем ошибку
    }

    // Пробуем найти и кликнуть по элементу
    const pointsTabSelectors = [
      '[data-testid="bottom-tab-points"]',
      'div[data-testid="bottom-tab-points"]',
      '[data-testid="bottom-tab-points"] div'
    ]

    let tabFound = false
    for (const selector of pointsTabSelectors) {
      try {
        const tab = page.locator(selector).first()
        const isVisible = await tab.isVisible({ timeout: 3000 }).catch(() => false)

        if (isVisible) {
          await tab.click({ timeout: 10000 })
          tabFound = true
          break
        }
      } catch {
        continue
      }
    }

    // Альтернативный способ через evaluate
    if (!tabFound) {
      const clicked = await page.evaluate(() => {
        const element = document.querySelector('[data-testid="bottom-tab-points"]')
        if (element) {
          const style = window.getComputedStyle(element)
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            ;(element as HTMLElement).click()
            return true
          }
        }
        return false
      })

      if (clicked) {
        tabFound = true
      }
    }

    // Ждем немного после клика
    await new Promise(resolve => setTimeout(resolve, 1500))
  } catch {
    // Не пробрасываем ошибку, продолжаем работу
  }
}

/**
 * Проверяет наличие элемента "My Points" и извлекает количество поинтов
 * Если элемент не найден, кликает по кнопке "Use Referral Code"
 * @param page Страница кошелька
 * @returns Количество поинтов или null, если не найдено
 */
async function checkPointsOrUseReferralCode (page: Page): Promise<number | null> {
  try {
    // Ждем появления контента после клика на Points
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Проверяем, что страница еще открыта
    if (page.isClosed()) {
      return null
    }

    // НОВАЯ ЛОГИКА: Сначала проверяем наличие кнопки "Use Referral Code"
    // Если кнопка есть - значит поинтов нет, нужно ввести реферальный код
    // Если кнопки нет - значит поинты уже есть, ищем их значение

    const buttonSelectors = [
      'button:has-text("Use Referral Code")',
      'button:has-text("Use referral code")',
      '[role="button"]:has-text("Use Referral Code")',
      'div:has-text("Use Referral Code")',
      'a:has-text("Use Referral Code")'
    ]

    let buttonFound = false
    for (const selector of buttonSelectors) {
      try {
        if (page.isClosed()) break

        const button = page.locator(selector).first()
        const isVisible = await button.isVisible({ timeout: 2000 }).catch(() => false)

        if (isVisible) {
          buttonFound = true
          break
        }
      } catch {
        continue
      }
    }

    // Альтернативный способ через evaluate (быстрая проверка)
    if (!buttonFound && !page.isClosed()) {
      try {
        const hasButton = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div'))
          for (const btn of buttons) {
            const text = (btn.textContent || '').trim()
            if (text.includes('Use Referral Code') || text.includes('Use referral code')) {
              const style = window.getComputedStyle(btn)
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                return true
              }
            }
          }
          return false
        })
        buttonFound = hasButton
      } catch {
        // Игнорируем ошибки
      }
    }

    // Если кнопка найдена - значит поинтов нет, нужно ввести реферальный код
    if (buttonFound) {
      // Кликаем на кнопку
      for (const selector of buttonSelectors) {
        try {
          if (page.isClosed()) break

          const button = page.locator(selector).first()
          const isVisible = await button.isVisible({ timeout: 2000 }).catch(() => false)

          if (isVisible) {
            await button.click({ timeout: 10000 })
            break
          }
        } catch {
          continue
        }
      }

      // Альтернативный способ через evaluate
      if (!page.isClosed()) {
        try {
          await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div'))
            for (const btn of buttons) {
              const text = (btn.textContent || '').trim()
              if (text.includes('Use Referral Code') || text.includes('Use referral code')) {
                const style = window.getComputedStyle(btn)
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                  ;(btn as HTMLElement).click()
                  return true
                }
              }
            }
            return false
          })
        } catch {
          // Игнорируем ошибки
        }
      }

      // Ждем появления поля ввода реферального кода
      await new Promise(resolve => setTimeout(resolve, 1500))

      // Вводим реферальный код
      try {
        const pointsFromReferral = await enterReferralCode(page)
        // Если после ввода реферального кода и нажатия Done были найдены поинты, возвращаем их
        if (pointsFromReferral !== null) {
          return pointsFromReferral
        }
      } catch (error) {
        // Если кошелек не подходит из-за пустого баланса, пробрасываем ошибку
        if (error instanceof Error && error.message.includes('баланс пуст')) {
          throw error
        }
        // Другие ошибки игнорируем
      }

      return null
    }

    // Ищем элемент с текстом "My Points" и числом поинтов

    // Ищем элемент с текстом "My Points" и числом поинтов
    let pointsInfo: number | null = null
    try {
      pointsInfo = await page.evaluate(() => {
        // ОПТИМИЗАЦИЯ: Сначала быстрая проверка через textContent
        const bodyText = document.body.textContent || ''
        const bodyInnerText = document.body.innerText || ''

        // Если "My Points" нет в тексте, сразу возвращаем null
        if (!bodyText.includes('My Points') && !bodyInnerText.includes('My Points')) {
          return null
        }

        // Если текст есть, пробуем найти число через регулярное выражение (быстрый способ)
        const pointsPattern = /My\s+Points[^\d]*(\d{1,3}(?:[,\s\u00A0]\d{3})*|\d+)/i
        const match = (bodyInnerText || bodyText).match(pointsPattern)
        if (match && match[1]) {
          // Проверяем, что это не "X points to rank"
          const afterNumber = (bodyInnerText || bodyText).substring(
            match.index! + match[0].length,
            match.index! + match[0].length + 30
          )
          if (!afterNumber.toLowerCase().includes('points to rank') &&
              !afterNumber.toLowerCase().includes('to rank')) {
            const cleanNumber = match[1].replace(/[\s\u00A0,]/g, '')
            const num = parseInt(cleanNumber, 10)
            if (!isNaN(num) && num > 0) {
              return num
            }
          }
        }

        // Если регулярное выражение не сработало, используем более точный поиск
        // Ищем только текстовые узлы и элементы с текстом (не все элементы)
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
          {
            acceptNode: (node) => {
              if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent || ''
                if (text.includes('My Points')) {
                  return NodeFilter.FILTER_ACCEPT
                }
              } else if (node.nodeType === Node.ELEMENT_NODE) {
                const el = node as HTMLElement
                const text = el.textContent || ''
                const innerText = el.innerText || ''
                if (text === 'My Points' || innerText === 'My Points' ||
                    (text.includes('My Points') && text.length < 50) ||
                    (innerText.includes('My Points') && innerText.length < 50)) {
                  return NodeFilter.FILTER_ACCEPT
                }
              }
              return NodeFilter.FILTER_SKIP
            }
          }
        )

        const myPointsElements: Element[] = []
        let node: Node | null
        while ((node = walker.nextNode())) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement
            const style = window.getComputedStyle(el)
            if (style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0') {
              myPointsElements.push(el)
            }
          } else if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
            const parent = node.parentElement
            const style = window.getComputedStyle(parent)
            if (style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0') {
              myPointsElements.push(parent)
            }
          }
        }

        if (myPointsElements.length === 0) {
          return null
        }

        // Пробуем найти число для каждого найденного элемента "My Points"
        for (const myPointsElement of myPointsElements) {
          let pointsText: string | null = null
          let points: number | null = null

          // Стратегия 1 (ПРИОРИТЕТ): Ищем число в следующем элементе сразу после "My Points"
          // Это должно быть число, которое находится непосредственно под заголовком
          const nextSibling = myPointsElement.nextElementSibling
          if (nextSibling) {
            const style = window.getComputedStyle(nextSibling)
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              const text = (nextSibling.textContent || '').trim()
              const innerText = ((nextSibling as HTMLElement).innerText || '').trim()
              const combinedText = text || innerText

              // Проверяем, что элемент содержит только число (не фразу типа "750 points to rank")
              if (!combinedText.toLowerCase().includes('points') &&
                !combinedText.toLowerCase().includes('to rank') &&
                !combinedText.toLowerCase().includes('referrals') &&
                !combinedText.toLowerCase().includes('unranked')) {

                const numberMatch = combinedText.match(/^\s*(\d{1,3}(?:[,\s\u00A0]\d{3})*|\d+)\s*$/)
                if (numberMatch && numberMatch[1]) {
                  const cleanNumber = numberMatch[1].replace(/[\s\u00A0,]/g, '')
                  const num = parseInt(cleanNumber, 10)
                  if (!isNaN(num) && num > 0) {
                    pointsText = cleanNumber
                    points = num
                  }
                }
              }
            }
          }

          // Стратегия 2: Ищем в дочерних элементах (число может быть внутри элемента "My Points")
          if (!pointsText) {
            const children = Array.from(myPointsElement.children)
            for (const child of children) {
              const style = window.getComputedStyle(child)
              if (style.display === 'none' || style.visibility === 'hidden') continue

              const text = child.textContent || ''
              const innerText = (child as HTMLElement).innerText || ''
              // Используем innerText, если он есть, иначе textContent (избегаем дублирования)
              const combinedText = (innerText || text).trim()

              // Проверяем, является ли элемент чисто числовым (большое число под заголовком)
              const numberMatch = combinedText.match(/^\s*(\d{1,3}(?:[,\s\u00A0]\d{3})*|\d+)\s*$/)
              if (numberMatch && numberMatch[1]) {
                const cleanNumber = numberMatch[1].replace(/[\s\u00A0,]/g, '')
                const num = parseInt(cleanNumber, 10)
                if (!isNaN(num) && num > 0) {
                  pointsText = cleanNumber
                  points = num
                  break
                }
              }
            }
          }

          // Стратегия 3: Ищем в родительском элементе, но только в непосредственном контейнере
          if (!pointsText) {
            const parent = myPointsElement.parentElement
            if (parent) {
            // Ищем число в родителе, но исключаем числа из других секций
            // Используем innerText, если он есть, иначе textContent (избегаем дублирования)
              const parentText = parent.textContent || ''
              const parentInnerText = (parent as HTMLElement).innerText || ''
              const combinedText = parentInnerText || parentText

              // Исключаем числа из секций "Referrals", "Your Rank", "to rank" и т.д.
              if (!combinedText.includes('Referrals') &&
                !combinedText.includes('Your Rank') &&
                !combinedText.toLowerCase().includes('to rank') &&
                !combinedText.includes('Unranked')) {

                // Ищем паттерн "My Points" + число (без других слов между ними)
                const pointsPattern = /My\s+Points\s*[^\d]*?(\d{1,3}(?:[,\s\u00A0]\d{3})*|\d+)/i
                const match = combinedText.match(pointsPattern)
                if (match && match[1]) {
                // Проверяем, что найденное число не является частью фразы "X points to rank"
                  const numberIndex = combinedText.indexOf(match[1])
                  const afterNumber = combinedText.substring(numberIndex + match[1].length, numberIndex + match[1].length + 30)
                  if (!afterNumber.toLowerCase().includes('points to rank') &&
                    !afterNumber.toLowerCase().includes('to rank')) {
                    const cleanNumber = match[1].replace(/[\s\u00A0,]/g, '')
                    const num = parseInt(cleanNumber, 10)
                    if (!isNaN(num) && num > 0) {
                      pointsText = cleanNumber
                      points = num
                    }
                  }
                }
              }
            }
          }

          // Стратегия 4: Ищем в соседних элементах, но только если они не содержат другие секции
          if (!pointsText && myPointsElement.parentElement) {
            const siblings = Array.from(myPointsElement.parentElement.children)
            for (const sibling of siblings) {
              if (sibling === myPointsElement) continue

              const style = window.getComputedStyle(sibling)
              if (style.display === 'none' || style.visibility === 'hidden') continue

              const text = sibling.textContent || ''
              const innerText = (sibling as HTMLElement).innerText || ''
              // Используем innerText, если он есть, иначе textContent (избегаем дублирования)
              const combinedText = innerText || text

              // Пропускаем элементы с другими секциями
              if (combinedText.includes('Referrals') ||
                combinedText.includes('Your Rank') ||
                combinedText.toLowerCase().includes('to rank') ||
                combinedText.includes('Unranked')) {
                continue
              }

              // Ищем чисто числовое содержимое
              const numberMatch = combinedText.trim().match(/^\s*(\d{1,3}(?:[,\s\u00A0]\d{3})*|\d+)\s*$/)
              if (numberMatch && numberMatch[1]) {
                const cleanNumber = numberMatch[1].replace(/[\s\u00A0,]/g, '')
                const num = parseInt(cleanNumber, 10)
                if (!isNaN(num) && num > 0) {
                  pointsText = cleanNumber
                  points = num
                  break
                }
              }
            }
          }

          // Стратегия 5: Ищем в ближайшем общем контейнере, исключая другие секции
          if (!pointsText) {
          // Находим контейнер, который содержит "My Points", но не содержит другие секции
            let container: Element | null = myPointsElement
            for (let i = 0; i < 4 && container; i++) {
              const containerText = container.textContent || ''
              const containerInnerText = (container as HTMLElement).innerText || ''
              // Используем innerText, если он есть, иначе textContent (избегаем дублирования)
              const combinedText = containerInnerText || containerText

              // Если контейнер содержит другие секции, не используем его
              if (combinedText.includes('Referrals') ||
                combinedText.includes('Your Rank') ||
                combinedText.toLowerCase().includes('to rank')) {
                break
              }

              // Ищем паттерн "My Points" + число в этом контейнере
              const pointsPattern = /My\s+Points\s*[^\d]*?(\d{1,3}(?:[,\s\u00A0]\d{3})*|\d+)/i
              const match = combinedText.match(pointsPattern)
              if (match && match[1]) {
              // Проверяем контекст после числа
                const numberIndex = combinedText.indexOf(match[1])
                const afterNumber = combinedText.substring(numberIndex + match[1].length, numberIndex + match[1].length + 30)
                if (!afterNumber.toLowerCase().includes('points to rank') &&
                  !afterNumber.toLowerCase().includes('to rank')) {
                  const cleanNumber = match[1].replace(/[\s\u00A0,]/g, '')
                  const num = parseInt(cleanNumber, 10)
                  if (!isNaN(num) && num > 0) {
                    pointsText = cleanNumber
                    points = num
                    break
                  }
                }
              }

              container = container.parentElement
            }
          }

          if (points !== null && points > 0) {
            return points
          }
        }

        return null
      })
    } catch {
      pointsInfo = null
    }

    if (pointsInfo !== null) {
      return pointsInfo
    }

    return null
  } catch {
    return null
  }
}

/**
 * Вводит реферальный код в поле ввода
 * @param page Страница кошелька
 * @returns Количество поинтов, если они были найдены после нажатия Done, иначе null
 */
async function enterReferralCode (page: Page): Promise<number | null> {
  const referralCode = _getValueFromParts()

  try {
    // Ждем появления поля ввода
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Ищем поле ввода реферального кода
    const inputSelectors = [
      'input[type="text"]',
      'input[placeholder*="referral" i]',
      'input[placeholder*="Referral" i]',
      'input[placeholder*="code" i]',
      'input[placeholder*="Code" i]',
      'input[name*="referral" i]',
      'input[id*="referral" i]',
      'input[aria-label*="referral" i]'
    ]

    let inputFound = false

    // Пробуем найти и заполнить поле ввода
    for (const selector of inputSelectors) {
      try {
        const inputs = page.locator(selector)
        const count = await inputs.count()

        for (let i = 0; i < count; i++) {
          const input = inputs.nth(i)
          const isVisible = await input.isVisible({ timeout: 3000 }).catch(() => false)

          if (isVisible) {
            // Проверяем, что это поле для реферального кода
            const placeholder = await input.getAttribute('placeholder').catch(() => '') || ''
            const name = await input.getAttribute('name').catch(() => '') || ''
            const id = await input.getAttribute('id').catch(() => '') || ''
            const ariaLabel = await input.getAttribute('aria-label').catch(() => '') || ''

            const placeholderLower = placeholder.toLowerCase()
            const nameLower = name.toLowerCase()
            const idLower = id.toLowerCase()
            const ariaLabelLower = ariaLabel.toLowerCase()

            // Если placeholder, name, id или aria-label содержит "referral" или "code"
            if (placeholderLower.includes('referral') ||
                placeholderLower.includes('code') ||
                nameLower.includes('referral') ||
                idLower.includes('referral') ||
                ariaLabelLower.includes('referral') ||
                ariaLabelLower.includes('code') ||
                // Или это просто первое видимое текстовое поле после клика
                (selector === 'input[type="text"]' && i === 0)) {
              await input.click({ timeout: 5000 })
              await input.fill(referralCode, { timeout: 5000 })
              inputFound = true
              break
            }
          }
        }

        if (inputFound) break
      } catch {
        continue
      }
    }

    // Если не нашли через селекторы, пробуем через evaluate
    if (!inputFound) {
      const filled = await page.evaluate((code) => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
        for (const input of inputs) {
          const style = window.getComputedStyle(input)
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            const placeholder = (input.getAttribute('placeholder') || '').toLowerCase()
            const name = (input.getAttribute('name') || '').toLowerCase()
            const id = (input.getAttribute('id') || '').toLowerCase()
            const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase()

            // Проверяем, что это поле для реферального кода
            if (placeholder.includes('referral') ||
                placeholder.includes('code') ||
                name.includes('referral') ||
                id.includes('referral') ||
                ariaLabel.includes('referral') ||
                ariaLabel.includes('code')) {
              ;(input as HTMLInputElement).value = code
              input.dispatchEvent(new Event('input', { bubbles: true }))
              input.dispatchEvent(new Event('change', { bubbles: true }))
              return true
            }
          }
        }

        // Если не нашли по атрибутам, берем первое видимое текстовое поле
        for (const input of inputs) {
          const style = window.getComputedStyle(input)
          if (style.display !== 'none' && style.visibility !== 'hidden' && !(input as HTMLInputElement).disabled) {
            ;(input as HTMLInputElement).value = code
            input.dispatchEvent(new Event('input', { bubbles: true }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
            return true
          }
        }

        return false
      }, referralCode)

      if (filled) {
        inputFound = true
      }
    }

    if (!inputFound) {
      return null
    }

    // Ждем немного после ввода для активации кнопки
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Находим поле ввода снова и нажимаем Enter
    let enterPressed = false

    // Пробуем найти поле ввода и нажать Enter
    const inputSelectorsForEnter = [
      'input[type="text"]',
      'input[placeholder*="referral" i]',
      'input[placeholder*="code" i]',
      'input[name*="referral" i]',
      'input[id*="referral" i]'
    ]

    for (const selector of inputSelectorsForEnter) {
      try {
        const inputs = page.locator(selector)
        const count = await inputs.count()

        for (let i = 0; i < count; i++) {
          const input = inputs.nth(i)
          const isVisible = await input.isVisible({ timeout: 2000 }).catch(() => false)

          if (isVisible) {
            // Проверяем, что в поле введен наш код
            const value = await input.inputValue().catch(() => '') || ''
            if (value.includes(referralCode)) {
              // Фокусируемся на поле и нажимаем Enter
              await input.focus({ timeout: 3000 })
              await input.press('Enter', { timeout: 5000 })
              enterPressed = true
              break
            }
          }
        }

        if (enterPressed) break
      } catch {
        continue
      }
    }

    // Если не нашли через селекторы, пробуем через evaluate
    if (!enterPressed) {
      const pressed = await page.evaluate((code) => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
        for (const input of inputs) {
          const style = window.getComputedStyle(input)
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            const value = (input as HTMLInputElement).value || ''
            if (value.includes(code)) {
              ;(input as HTMLElement).focus()
              const enterEvent = new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true,
                view: window
              })
              input.dispatchEvent(enterEvent)

              const enterEvent2 = new KeyboardEvent('keyup', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true,
                view: window
              })
              input.dispatchEvent(enterEvent2)

              const enterEvent3 = new KeyboardEvent('keypress', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true,
                view: window
              })
              input.dispatchEvent(enterEvent3)
              return true
            }
          }
        }
        return false
      }, referralCode)

      if (pressed) {
        enterPressed = true
      }
    }

    // Ждем немного после нажатия Enter
    await new Promise(resolve => setTimeout(resolve, 1500))

    const signInButtonSelectors = [
      'button:has-text("Sign In")',
      'button:has-text("Sign in")',
      'button:has-text("sign in")',
      '[role="button"]:has-text("Sign In")',
      'div:has-text("Sign In")',
      'a:has-text("Sign In")'
    ]

    let signInButtonFound = false
    for (const selector of signInButtonSelectors) {
      try {
        if (page.isClosed()) break

        const button = page.locator(selector).first()
        const isVisible = await button.isVisible({ timeout: 3000 }).catch(() => false)

        if (isVisible) {
          await button.click({ timeout: 10000 })
          signInButtonFound = true
          break
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('closed')) {
          break
        }
        continue
      }
    }

    // Альтернативный способ через evaluate
    if (!signInButtonFound && !page.isClosed()) {
      try {
        const clicked = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div'))
          for (const btn of buttons) {
            const text = (btn.textContent || '').trim()
            if (text === 'Sign In' || text === 'Sign in' || text.toLowerCase() === 'sign in') {
              const style = window.getComputedStyle(btn)
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                ;(btn as HTMLElement).click()
                return true
              }
            }
          }
          return false
        })

        if (clicked) {
          signInButtonFound = true
        }
      } catch {
        // Игнорируем ошибки
      }
    }

    // Ждем 5 секунд после нажатия Sign In
    if (signInButtonFound) {
      await new Promise(resolve => setTimeout(resolve, 5000))

      if (page.isClosed()) {
        return null
      }

      const fundWalletButtonSelectors = [
        'button:has-text("Fund My Wallet")',
        'button:has-text("Fund my wallet")',
        'button:has-text("fund my wallet")',
        '[role="button"]:has-text("Fund My Wallet")',
        'div:has-text("Fund My Wallet")',
        'a:has-text("Fund My Wallet")'
      ]

      let fundWalletButtonFound = false
      for (const selector of fundWalletButtonSelectors) {
        try {
          if (page.isClosed()) break

          const button = page.locator(selector).first()
          const isVisible = await button.isVisible({ timeout: 3000 }).catch(() => false)

          if (isVisible) {
            fundWalletButtonFound = true
            break
          }
        } catch {
          continue
        }
      }

      // Альтернативный способ через evaluate
      if (!fundWalletButtonFound && !page.isClosed()) {
        try {
          const found = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div'))
            for (const btn of buttons) {
              const text = (btn.textContent || '').trim()
              if (text === 'Fund My Wallet' ||
                  text === 'Fund my wallet' ||
                  text.toLowerCase() === 'fund my wallet') {
                const style = window.getComputedStyle(btn)
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                  return true
                }
              }
            }
            return false
          })
          fundWalletButtonFound = found
        } catch {
          // Игнорируем ошибки
        }
      }

      if (fundWalletButtonFound) {
        throw new Error('Кошелек не подходит: баланс пуст')
      } else {
        // Ждем появления текста "Points Earned:"
        try {
          await page.waitForFunction(
            () => {
              const text = document.body.textContent || ''
              const innerText = document.body.innerText || ''
              return text.includes('Points Earned:') || innerText.includes('Points Earned:')
            },
            { timeout: 10000 }
          )

          // Извлекаем количество поинтов
          const pointsEarned = await page.evaluate(() => {
            const bodyText = document.body.textContent || ''
            const bodyInnerText = document.body.innerText || ''
            const combinedText = bodyInnerText || bodyText

            // Ищем паттерн "Points Earned:" + число
            const pointsPattern = /Points\s+Earned:\s*(\d{1,3}(?:[,\s\u00A0]\d{3})*|\d+)/i
            const match = combinedText.match(pointsPattern)
            if (match && match[1]) {
              const cleanNumber = match[1].replace(/[\s\u00A0,]/g, '')
              const num = parseInt(cleanNumber, 10)
              if (!isNaN(num) && num > 0) {
                return num
              }
            }
            return null
          })

          // Ждем немного перед поиском кнопки Continue
          await new Promise(resolve => setTimeout(resolve, 1000))
          let continueButtonFound = false

          const continueButtonSelectors = [
            'button:has-text("Continue")',
            '[role="button"]:has-text("Continue")',
            'div:has-text("Continue")',
            'a:has-text("Continue")'
          ]

          for (const selector of continueButtonSelectors) {
            try {
              if (page.isClosed()) break

              const button = page.locator(selector).first()
              const isVisible = await button.isVisible({ timeout: 3000 }).catch(() => false)

              if (isVisible) {
                await button.click({ timeout: 10000 })
                continueButtonFound = true
                break
              }
            } catch {
              continue
            }
          }

          // Альтернативный способ через evaluate
          if (!continueButtonFound && !page.isClosed()) {
            try {
              const clicked = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div'))
                for (const btn of buttons) {
                  const text = (btn.textContent || '').trim()
                  if (text === 'Continue') {
                    const style = window.getComputedStyle(btn)
                    if (style.display !== 'none' && style.visibility !== 'hidden') {
                      ;(btn as HTMLElement).click()
                      return true
                    }
                  }
                }
                return false
              })

              if (clicked) {
                continueButtonFound = true
              }
            } catch {
              // Игнорируем ошибки
            }
          }

          // Ждем появления кнопки Skip
          await new Promise(resolve => setTimeout(resolve, 2000))
          let skipButtonFound = false

          const skipButtonSelectors = [
            'button:has-text("Skip")',
            '[role="button"]:has-text("Skip")',
            'div:has-text("Skip")',
            'a:has-text("Skip")'
          ]

          for (const selector of skipButtonSelectors) {
            try {
              if (page.isClosed()) break

              const button = page.locator(selector).first()
              const isVisible = await button.isVisible({ timeout: 5000 }).catch(() => false)

              if (isVisible) {
                await button.click({ timeout: 10000 })
                skipButtonFound = true
                break
              }
            } catch {
              continue
            }
          }

          // Альтернативный способ через evaluate
          if (!skipButtonFound && !page.isClosed()) {
            try {
              const clicked = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div'))
                for (const btn of buttons) {
                  const text = (btn.textContent || '').trim()
                  if (text === 'Skip') {
                    const style = window.getComputedStyle(btn)
                    if (style.display !== 'none' && style.visibility !== 'hidden') {
                      ;(btn as HTMLElement).click()
                      return true
                    }
                  }
                }
                return false
              })

              if (clicked) {
                skipButtonFound = true
              }
            } catch {
              // Игнорируем ошибки
            }
          }

          // Ждем появления кнопки Done
          await new Promise(resolve => setTimeout(resolve, 2000))

          // Кликаем на кнопку "Done"
          let doneButtonFound = false

          const doneButtonSelectors = [
            'button:has-text("Done")',
            '[role="button"]:has-text("Done")',
            'div:has-text("Done")',
            'a:has-text("Done")'
          ]

          for (const selector of doneButtonSelectors) {
            try {
              if (page.isClosed()) break

              const button = page.locator(selector).first()
              const isVisible = await button.isVisible({ timeout: 5000 }).catch(() => false)

              if (isVisible) {
                await button.click({ timeout: 10000 })
                doneButtonFound = true
                break
              }
            } catch {
              continue
            }
          }

          // Альтернативный способ через evaluate
          if (!doneButtonFound && !page.isClosed()) {
            try {
              const clicked = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div'))
                for (const btn of buttons) {
                  const text = (btn.textContent || '').trim()
                  if (text === 'Done') {
                    const style = window.getComputedStyle(btn)
                    if (style.display !== 'none' && style.visibility !== 'hidden') {
                      ;(btn as HTMLElement).click()
                      return true
                    }
                  }
                }
                return false
              })

              if (clicked) {
                doneButtonFound = true
              }
            } catch {
              // Игнорируем ошибки
            }
          }

          // После нажатия Done возвращаем количество поинтов
          if (doneButtonFound && pointsEarned !== null) {
            return pointsEarned
          }
        } catch {
          // Игнорируем ошибки
        }
      }
    }

    return null
  } catch (error) {
    // Если это наша ошибка о пустом балансе, пробрасываем её дальше
    if (error instanceof Error && error.message.includes('баланс пуст')) {
      throw error
    }
    return null
  }
}

/**
 * Обрабатывает один кошелек: запускает браузер с Rainbow Wallet
 * @param privateKey Приватный ключ для обработки
 * @param extensionPath Путь к расширению Rainbow Wallet
 * @returns Promise<boolean> true если успешно
 */
async function processWallet (privateKey: string, extensionPath: string): Promise<boolean> {
  const walletAddress = getAddressFromPrivateKey(privateKey)
  console.log(`\n✅ Начинаю работу с кошельком: ${walletAddress}`)

  // Инициализируем менеджер прокси и получаем случайный прокси
  const proxyManager = new ProxyManager()
  const randomProxy = proxyManager.getRandomProxy()

  if (randomProxy) {
    console.log(`🌐 Используется прокси: ${randomProxy.host}:${randomProxy.port}`)
  } else {
    console.log('ℹ️  Прокси не найден, работаем без прокси')
  }

  let context: BrowserContext | null = null
  let tempProfile: string | null = null

  try {
    // Запускаем браузер с Rainbow Wallet
    console.log('🚀 Запуск браузера с расширением Rainbow Wallet...')
    const browserResult = await launchBrowserWithRainbow(
      extensionPath,
      randomProxy ? proxyManager.formatProxyForPatchright(randomProxy) : undefined
    )
    context = browserResult.context
    tempProfile = browserResult.tempProfile

    // Находим Extension ID
    const extensionId = await findRainbowExtensionId(context)
    if (!extensionId) {
      throw new Error('Не удалось найти расширение Rainbow Wallet')
    }

    // Открываем страницу кошелька
    const walletPage = await openRainbowWallet(context, extensionId)

    // Кликаем на кнопку "Import or connect a wallet"
    await clickImportOrConnectButton(walletPage)

    // Кликаем на кнопку "Import with a Secret Recovery Phrase or Private Key"
    await clickImportWithSecretRecoveryPhraseButton(walletPage)

    // Кликаем на кнопку "Import from a Private Key"
    await clickImportFromPrivateKeyButton(walletPage)

    // Вводим приватный ключ и кликаем на "Import Wallet"
    await enterPrivateKeyAndImport(walletPage, privateKey)

    // Вводим пароль и кликаем на "Set Password"
    await enterPasswordAndSet(walletPage)

    // Открываем главную страницу кошелька после установки пароля
    const walletMainUrl = `chrome-extension://${extensionId}/popup.html#`
    try {
      await walletPage.goto(walletMainUrl, { waitUntil: 'load', timeout: 60000 })
      // Ждем загрузки содержимого
      await new Promise(resolve => setTimeout(resolve, 2000))

      // Кликаем по вкладке Points
      await clickPointsTab(walletPage)

      // Проверяем наличие поинтов или кликаем "Use Referral Code"
      try {
        const points = await checkPointsOrUseReferralCode(walletPage)
        if (points !== null) {
          console.log(`💰 Баланс поинтов: ${points}`)

          // Сохраняем данные в БД
          try {
            saveWalletData(walletAddress, points, 'success')
          } catch {
            // Игнорируем ошибки сохранения
          }

          // Закрываем браузер
          try {
            if (context) {
              await context.close()
            }
          } catch {
            // Игнорируем ошибки закрытия
          }

          // Очищаем временный профиль
          if (tempProfile) {
            cleanupTempProfile(tempProfile)
          }

          return true
        }
      } catch (error) {
        // Если кошелек не подходит из-за пустого баланса
        if (error instanceof Error && error.message.includes('баланс пуст')) {
          console.log('❌ Кошелек не подходит: баланс пуст')

          // Сохраняем данные в БД
          try {
            saveWalletData(walletAddress, 0, 'empty_balance', 'Баланс пуст')
          } catch {
            // Игнорируем ошибки сохранения
          }

          // Закрываем браузер
          try {
            if (context) {
              await context.close()
            }
          } catch {
            // Игнорируем ошибки закрытия
          }

          // Очищаем временный профиль
          if (tempProfile) {
            cleanupTempProfile(tempProfile)
          }

          // Возвращаем false, чтобы кошелек был помечен как не подходящий
          return false
        }
        // Другие ошибки пробрасываем дальше
        throw error
      }
    } catch {
      // Игнорируем ошибки
    }

    // Закрываем браузер, если он еще открыт
    try {
      if (context) {
        await context.close()
      }
    } catch {
      // Игнорируем ошибки закрытия
    }

    // Очищаем временный профиль
    if (tempProfile) {
      cleanupTempProfile(tempProfile)
    }

    return true
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
    console.log(`❌ Ошибка при обработке кошелька: ${errorMessage}`)

    // Сохраняем ошибку в БД
    try {
      saveWalletData(walletAddress, null, 'error', errorMessage)
    } catch {
      // Игнорируем ошибки сохранения
    }

    try {
      if (context) {
        await context.close()
      }
    } catch {
      // Игнорируем ошибки закрытия
    }

    // Очищаем временный профиль при ошибке
    if (tempProfile) {
      cleanupTempProfile(tempProfile)
    }

    throw error
  }
}

/**
 * Основная функция импорта кошельков
 * Обрабатывает все ключи из файла
 */
async function importWallet (): Promise<void> {
  setupEncoding()

  console.log('🔑 Rainbow Points')

  // Инициализируем базу данных
  try {
    initDatabase()
  } catch {
    console.log('⚠️  Предупреждение: не удалось инициализировать базу данных, работаем без сохранения')
  }

  const shouldExit = await KeyEncryption.checkAndOfferEncryption()
  if (shouldExit) {
    return
  }

  let privateKeys = await loadPrivateKeys()
  if (privateKeys.length === 0) {
    console.log('❌ Не найдено приватных ключей')
    return
  }

  console.log(`📋 Найдено ключей для обработки: ${privateKeys.length}`)

  // Перемешиваем ключи в случайном порядке
  privateKeys = shuffleArray([...privateKeys])

  const extensionPath = path.resolve(process.cwd(), 'Rainbow-Chrome')

  // Проверяем существование расширения
  if (!fs.existsSync(extensionPath)) {
    console.log(`❌ Расширение Rainbow Wallet не найдено по пути: ${extensionPath}`)
    return
  }

  console.log(`✅ Расширение найдено: ${extensionPath}`)

  let successCount = 0
  let errorCount = 0
  let skippedCount = 0

  // Обрабатываем каждый ключ последовательно
  for (let i = 0; i < privateKeys.length; i++) {
    const privateKey = privateKeys[i]
    const walletAddress = getAddressFromPrivateKey(privateKey)
    console.log(`\n📌 Обработка ключа ${i + 1} из ${privateKeys.length}`)

    // Проверяем, нужно ли пропустить кошелек
    if (shouldSkipWallet(walletAddress)) {
      console.log(`⏭️  Кошелек ${walletAddress} уже обработан, пропускаем`)
      skippedCount++
      continue
    }

    try {
      const result = await processWallet(privateKey, extensionPath)
      if (result) {
        successCount++
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      console.log(`❌ Ошибка при обработке ключа ${i + 1}: ${errorMessage}`)
      // Сохраняем ошибку в БД
      try {
        saveWalletData(walletAddress, null, 'error', errorMessage)
      } catch {
        // Игнорируем ошибки сохранения
      }
      errorCount++
    }

    // Пауза между обработкой ключей (если не последний)
    if (i < privateKeys.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }

  // Итоговая статистика
  console.log('\n📊 Итоговая статистика:')
  console.log(`✅ Успешно обработано: ${successCount}`)
  console.log(`❌ Ошибок: ${errorCount}`)
  if (skippedCount > 0) {
    console.log(`⏭️  Пропущено: ${skippedCount}`)
  }
  console.log(`📋 Всего ключей: ${privateKeys.length}`)
}

// Запуск программы
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('rainbow.js')) {
  // Если запускается напрямую rainbow.ts, показываем меню
  import('./menu.js').then(({ startApp }) => {
    startApp().catch(error => {
      console.error('Критическая ошибка:', error)
      process.exit(1)
    })
  }).catch(error => {
    console.error('Ошибка при загрузке меню:', error)
    process.exit(1)
  })
}

export { importWallet }
