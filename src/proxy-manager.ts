import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

export interface ProxyConfig {
  host: string
  port: number
  username: string
  password: string
}

export class ProxyManager {
  private static loggedOnce = false
  private proxies: ProxyConfig[] = []
  private currentIndex = 0

  constructor () {
    this.loadProxies()
  }

  /**
   * Загружает прокси из файла proxy.txt
   */
  private loadProxies (): void {
    const proxyFile = join(process.cwd(), 'proxy.txt')

    if (!existsSync(proxyFile)) {
      if (!ProxyManager.loggedOnce) {
        console.warn('⚠️  Файл proxy.txt не найден. Запросы будут выполняться без прокси.')
        ProxyManager.loggedOnce = true
      }
      return
    }

    try {
      const content = readFileSync(proxyFile, 'utf-8')
      const lines = content.split('\n').filter((line: string) => line.trim() && !line.startsWith('#'))

      for (const line of lines) {
        const parts = line.trim().split(':')
        if (parts.length === 4) {
          const [host, port, username, password] = parts
          this.proxies.push({
            host: host.trim(),
            port: parseInt(port.trim(), 10),
            username: username.trim(),
            password: password.trim()
          })
        }
      }

      if (!ProxyManager.loggedOnce) {
        console.log(`✅ Загружено ${this.proxies.length} прокси`)
        ProxyManager.loggedOnce = true
      }
    } catch (error) {
      console.error('❌ Ошибка при загрузке прокси:', error instanceof Error ? error.message : 'Неизвестная ошибка')
    }
  }

  /**
   * Получает случайный прокси
   */
  getRandomProxy (): ProxyConfig | null {
    if (this.proxies.length === 0) {
      return null
    }

    const randomIndex = Math.floor(Math.random() * this.proxies.length)
    return this.proxies[randomIndex]
  }

  /**
   * Получает следующий прокси в порядке очереди
   */
  getNextProxy (): ProxyConfig | null {
    if (this.proxies.length === 0) {
      return null
    }

    const proxy = this.proxies[this.currentIndex]
    this.currentIndex = (this.currentIndex + 1) % this.proxies.length
    return proxy
  }

  /**
   * Форматирует прокси для использования с fetch
   */
  formatProxyForFetch (proxy: ProxyConfig): string {
    return `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`
  }

  /**
   * Получает количество доступных прокси
   */
  getProxyCount (): number {
    return this.proxies.length
  }

  /**
   * Проверяет, есть ли доступные прокси
   */
  hasProxies (): boolean {
    return this.proxies.length > 0
  }

  /**
   * Проверяет работоспособность прокси через HTTP запрос
   */
  async testProxy (proxy: ProxyConfig): Promise<boolean> {
    try {
      const proxyUrl = this.formatProxyForFetch(proxy)

      // Устанавливаем прокси через переменные окружения
      const { env } = await import('process')
      env['HTTP_PROXY'] = proxyUrl
      env['HTTPS_PROXY'] = proxyUrl

      // Тестируем прокси через запрос к надежному endpoint
      const response = await fetch('https://httpbin.org/ip', {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        // Таймаут 10 секунд
        signal: AbortSignal.timeout(10000)
      })

      if (!response.ok) {
        return false
      }

      const data = await response.json()

      // Очищаем переменные окружения
      delete env['HTTP_PROXY']
      delete env['HTTPS_PROXY']

      // Проверяем, что получили IP адрес
      return data && data.origin && typeof data.origin === 'string'
    } catch {
      // Очищаем переменные окружения в случае ошибки
      const { env } = await import('process')
      delete env['HTTP_PROXY']
      delete env['HTTPS_PROXY']

      return false
    }
  }

  /**
   * Получает первый рабочий прокси из списка
   */
  async getWorkingProxy (): Promise<ProxyConfig | null> {
    if (this.proxies.length === 0) {
      return null
    }

    for (let i = 0; i < this.proxies.length; i++) {
      const proxy = this.proxies[i]
      const isWorking = await this.testProxy(proxy)

      if (isWorking) {
        return proxy
      }
    }

    return null
  }

  /**
   * Форматирует прокси для Chrome аргумента --proxy-server
   */
  formatProxyForChrome (proxy: ProxyConfig): string {
    return `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`
  }

  /**
   * Форматирует прокси для использования с Patchright/Playwright
   */
  formatProxyForPatchright (proxy: ProxyConfig) {
    return {
      server: `http://${proxy.host}:${proxy.port}`,
      username: proxy.username,
      password: proxy.password
    }
  }
}
