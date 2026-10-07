# MCP-сервер для ELMA365 — BPM-задачи, приложения low-code платформы и App Designer через ИИ

Если вы искали, как подключить ELMA365 к нейросети, запускать бизнес-процессы и закрывать BPM-задачи не заходя в веб-интерфейс — это оно. 12 инструментов: элементы приложений, задачи, процессы, пользователи, комментарии — плюс 3 инструмента для App Designer (`get_widget`, `get_widget_history`, `set_widget_script`), которые позволяют применить локальную правку скрипта виджета одной командой вместо ручной вставки в редактор Дизайнера. Спрашиваете «мои задачи на сегодня» — получаете список и закрываете их прямо в чате.

[![npm](https://img.shields.io/npm/v/@theyahia/elma365-mcp)](https://www.npmjs.com/package/@theyahia/elma365-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/theYahia/elma365-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/theYahia/elma365-mcp/actions)

Часть серии [WWmcp](https://github.com/theYahia/WWmcp) (46 серверов) by [@theYahia](https://github.com/theYahia).

## Установка

### Claude Desktop

```json
{
  "mcpServers": {
    "elma365": {
      "command": "npx",
      "args": ["-y", "@theyahia/elma365-mcp"],
      "env": {
        "ELMA365_DOMAIN": "mycompany",
        "ELMA365_TOKEN": "your-token"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add elma365 \
  -e ELMA365_DOMAIN=mycompany \
  -e ELMA365_TOKEN=your-token \
  -- npx -y @theyahia/elma365-mcp
```

### VS Code / Cursor

```json
{
  "servers": {
    "elma365": {
      "command": "npx",
      "args": ["-y", "@theyahia/elma365-mcp"],
      "env": {
        "ELMA365_DOMAIN": "mycompany",
        "ELMA365_TOKEN": "your-token"
      }
    }
  }
}
```

### Streamable HTTP (для веб-клиентов)

```bash
ELMA365_DOMAIN=mycompany ELMA365_TOKEN=your-token npx @theyahia/elma365-mcp --http --port 3000
```

Endpoint: `http://localhost:3000/mcp`
Health check: `http://localhost:3000/health`

### Smithery

Используйте `smithery.yaml` в корне репозитория для деплоя на [Smithery](https://smithery.ai).

> Требуется `ELMA365_DOMAIN` (домен или поддомен ELMA365, например `mycompany`) и `ELMA365_TOKEN` (Bearer API-токен).

## Инструменты (12)

| Инструмент | Описание |
|------------|----------|
| `get_app_items` | Список элементов приложения по namespace и code |
| `create_item` | Создание нового элемента в приложении |
| `get_tasks` | Список BPM-задач |
| `get_processes` | Список бизнес-процессов |
| `start_process` | Запуск бизнес-процесса по коду |
| `get_users` | Список пользователей |
| `get_user_by_id` | Получение пользователя по ID |
| `get_comments` | Комментарии к элементу приложения |
| `add_comment` | Добавить комментарий к элементу |
| `get_widget` | Текущее состояние виджета/формы в App Designer (версия, draft, скрипты) |
| `get_widget_history` | История публикаций виджета/формы |
| `set_widget_script` | Применить правку `clientScripts`/`serverScripts` через Дизайнер: вставка → Сохранить → Проверить → Опубликовать |

### App Designer tools — зачем они отдельные

Первые 9 инструментов используют `/pub/v1` REST API с Bearer-токеном.
`get_widget`/`get_widget_history`/`set_widget_script` — другое: они управляют
реальным (headless) браузером, авторизованным через email/пароль
администратора, потому что это единственный подтверждённо рабочий способ
опубликовать правку скрипта виджета сегодня:

- CLI `elma365pm import`/`check` падает на модулях типа `EXTENSION` с
  человекочитаемым кодом (`uuid: incorrect UUID length: <code>`) — известный
  баг, сервер-side валидация проходит, но применение не происходит.
- Прямой `PUT /api/widgets/{id}` требует живой сессионный JWT и
  `lock-hash`, которые формируются только клиентским кодом внутри
  авторизованной сессии Дизайнера — обойти это означало бы вытаскивать
  живой токен из браузерной сессии для использования вне неё, чего этот
  проект намеренно не делает.

Поэтому `set_widget_script` автоматизирует ровно тот же путь, что и человек
в браузере (вставка через буфер обмена, Сохранить, Проверить, Опубликовать),
но как один вызов инструмента. Каждый процесс MCP-сервера поднимает свой
собственный, изолированный в памяти экземпляр Chromium (ничего не
сохраняется на диск) — можно безопасно запускать несколько параллельных
сессий, не деля один профиль браузера.

Требует отдельно от Bearer-токена:

```
ELMA365_DESIGNER_EMAIL=admin@example.com
ELMA365_DESIGNER_PASSWORD=...
```

и (при первом использовании) браузер Chromium для Playwright:

```bash
npx playwright install chromium
```

`ELMA365_DESIGNER_HEADLESS=false` — запустить с видимым окном браузера для
отладки.

`get_widget_history` возвращает одну страницу исходного ответа ELMA без изменения
структуры: `offset` — смещение строк (по умолчанию 0), `size` — от 1 до 50
(по умолчанию 10). Для следующих страниц передавайте, например, `offset: 50`
при `size: 50`. Полная страница не доказывает полноту журнала; чтение во время
новых публикаций не является согласованным снимком истории. Метаданные автора
и версии сами по себе не доказывают связь с конкретной выгрузкой. Локальные
тесты проверяют запросы страниц, а не полноту живой истории сервера.

Что проверяет `set_widget_script` и что возвращает (с 2026-10-07):

- `expectedVersion` — при несовпадении версии ничего не открывается и не
  пишется (одно чтение состояния, ни одного PUT).
- Слушатель ответа ставится **до** клика и привязан к `PUT /api/widgets/{id}`
  именно этого виджета (heartbeat `/lock` и чужие виджеты не засчитываются);
  HTTP-статус попадает в ответ. После «Сохранить» черновик перечитывается с
  сервера и сравнивается с отправленным текстом целиком.
- Вердикт «Проверить» берётся из ответа `POST /api/widgets/compile`, а не из
  состояния кнопки: на ELMA365 2025.10 кнопка «Опубликовать» остаётся активной
  и диалог открывается даже при ошибках компиляции. Любая ошибка (кроме
  `level: "warning"`) — публикации нет, текст остаётся черновиком, в ответе
  список `errors`.
- После публикации состояние перечитывается: `draft:false` и полное совпадение
  текста — иначе `success:false`.
- В ответе поле `network` с `{status, ok, timedOut, path, body}` для
  save/validate/publish — это и есть доказательство, что именно произошло.

Поддерживаются оба поколения интерфейса Дизайнера: переключатель
Клиент/Сервер как радиокнопки (2025.4) и как кнопки-переключатели (2025.10);
диалог публикации ищется по тексту «Версия N», а не по accessible name.

Живая приёмка 2026-10-07 на non-production сервере (ELMA365 2025.10.97), виджет
`contract_management.contracts/additional_documents_viewer`: конфликт версии →
0 PUT; save-only → PUT 200, черновик совпал; намеренная ошибка типов →
`compile` вернул 2 ошибки, публикации нет; публикация маркера → v39; возврат
исходного текста → v40, скрипты и шаблон побайтно равны исходным. Остаток:
две записи в истории версий. Тот же цикл повторён на втором сервере со старым
интерфейсом (2025.4, радиокнопки) на тестовой форме `fbd_test.fbd_item/view_form`
(v2 → v4, скрипт побайтно равен исходному) — оба поколения интерфейса проверены
вживую. Учтите: первое сохранение через Дизайнер виджета, который до этого
писался только через `elma365pm import`, нормализует весь дескриптор (зона
`[footer]` → `zone-content`, `template.id`, `allowServer: true`, пустой модуль
`serverScripts` и т.п.) — это поведение самого Дизайнера, не инструмента.

## Skills (Claude Code)

| Skill | Описание |
|-------|----------|
| `/skill-my-tasks` | Мои задачи — показать текущие BPM-задачи |
| `/skill-start-process` | Запусти бизнес-процесс по коду |

## Примеры

```
Покажи элементы приложения deals/crm_deals
Создай новый элемент в приложении hr/candidates
Покажи мои BPM-задачи
Покажи список бизнес-процессов
Запусти процесс approval_flow с параметрами {"amount": 50000}
Покажи пользователей
Покажи комментарии к элементу item-123 в deals/crm_deals
Добавь комментарий "Согласовано" к элементу item-123 в deals/crm_deals
```

## Транспорт

| Режим | Команда | Описание |
|-------|---------|----------|
| stdio (по умолчанию) | `npx @theyahia/elma365-mcp` | Для Claude Desktop, Claude Code, Cursor |
| Streamable HTTP | `npx @theyahia/elma365-mcp --http` | Для веб-клиентов, port 3000 по умолчанию |
| Streamable HTTP (порт) | `npx @theyahia/elma365-mcp --http --port 8080` | Кастомный порт |

## Аутентификация

- `ELMA365_DOMAIN` — домен ELMA365 (например `mycompany` для `mycompany.elma365.ru`, или полный домен `mycompany.elma365.ru`)
- `ELMA365_TOKEN` — Bearer-токен для ELMA365 API

Базовый URL: `https://{domain}.elma365.ru/pub/v1/`

## Разработка

```bash
npm install
npm run build
npm test
npm run dev    # запуск через tsx
```

## Лицензия

MIT

---

Часть [WWmcp](https://github.com/theYahia/WWmcp) · Telegram: [@vhodvai](https://t.me/vhodvai)
