# MapControl

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/Status-MVP%20in%20progress-orange.svg)](CONTEXT.md)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Local-0078D6?logo=windows&logoColor=white)](CONTEXT.md)
[![Node.js](https://img.shields.io/badge/Node.js-Integration-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![sharp](https://img.shields.io/badge/Image%20Processing-sharp-2ea44f)](https://github.com/lovell/sharp)
[![JSON](https://img.shields.io/badge/Data-JSON-000000?logo=json)](CONTEXT.md)
[![WebP](https://img.shields.io/badge/Images-WebP-4285F4)](CONTEXT.md)
[![Yandex Maps](https://img.shields.io/badge/Maps-Yandex%20Maps%20API-red)](https://yandex.ru/dev/maps/)
[![LLM](https://img.shields.io/badge/LLM-Qwen%203.5%20Flash%20via%20RouterAI-8B5CF6)](CONTEXT.md)
[![nodemailer](https://img.shields.io/badge/Email-nodemailer%20v8-22B8CF)](https://nodemailer.com/)
[![Site](https://img.shields.io/badge/Integrates-Zavodsvay--Static-2ea44f)](https://github.com/AlexanderKuzikov/Zavodsvay-Static)

**Локальный конструктор заявок на объекты карты** для сайта [zavodsvay.ru](https://zavodsvay.ru/).  
Оператор собирает данные и фото, **LLM** выравнивает текст, **заявка отправляется на email администратора** вместе с фото и JSON-дампом объекта, администратор модерирует, кадрирует изображения и публикует объект в пайплайн [Zavodsvay-Static](https://github.com/AlexanderKuzikov/Zavodsvay-Static).

> **Статус:** рабочий MVP операторского контура: форма, карта, черновик, загрузка фото, LLM-проверка текста, отправка заявки в pending + доставка на email через SMTP (biz.mail.ru / smtp.mail.ru).  
> Архитектурные детали, журнал решений и следующие этапы — в [**CONTEXT.md**](CONTEXT.md).

---

## Что уже работает

- Создание черновика заявки в `data/submissions/draft/{submissionId}`
- Редактирование заголовка, технического описания и координат
- Выбор точки на карте через **Яндекс.Карты v3** или ручной ввод координат
- Загрузка фото оператором, конвертация в **WebP** через `sharp`
- LLM-проверка текста через OpenAI-compatible API
- Принятие правок LLM или сохранение исходного текста оператора
- Кнопки «Принять правки» / «Оставить мой» расположены под соответствующими колонками diff
- Отправка заявки в `data/submissions/pending/{submissionId}`
- **Email-уведомление при submit** — письмо с HTML-телом, сырым JSON объекта и прикреплёнными WebP-фото уходит на почту администратора через SMTP (`nodemailer` v8)
- Базовая серверная валидация и защита путей (`sanitizeId`, проверка path traversal)

---

## Актуальное решение по LLM

После тестов подтвердилось, что **качество Qwen 3.5 Flash подходит**, а основная проблема была в провайдере и latency. Для `vsellm.ru` удалось отключить thinking через `chat_template_kwargs: { enable_thinking: false }`, но ответ занимал около 1.5 минуты, что неприемлемо для операторского сценария.

Текущий рабочий вариант — **RouterAI** с моделью `qwen/qwen3.5-flash-02-23`: ответ приходит примерно за 2 секунды, даёт полезные warnings, `confidence`, и корректные правки без лишнего reasoning-трафика.

Конфиг в `.env`:

```env
LLM_BASE_URL=https://routerai.ru/api/v1
LLM_API_KEY=xxxxxx
LLM_MODEL=qwen/qwen3.5-flash-02-23
```

В коде уже заложены:
- `temperature: 0.1`
- `max_tokens: 512`
- `response_format: { type: 'json_object' }`
- `chat_template_kwargs: { enable_thinking: false }`
- fallback-очистка `<think>...</think>` если провайдер всё же вернёт reasoning в тексте

---

## Актуальное решение по Email

Для доставки заявок выбран **nodemailer v8** + **biz.mail.ru** (корпоративная почта VK WorkSpace на домене `exlibrum.ru`). Яндекс.360 отклонён как ненадёжный. Основной пароль не принимается — biz.mail.ru обязательно требует **пароль приложения** (генерируется после включения 2FA).

Письмо содержит:
- Человекочитаемый HTML-блок: объект, координаты, описание, оператор, дата
- Сырой JSON `meta` объекта в `<pre>` — для будущего машинного парсинга в админке
- WebP-фото как вложения

Конфиг в `.env`:

```env
SMTP_HOST=smtp.mail.ru
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=mapcontrol@exlibrum.ru
SMTP_PASS=пароль_приложения
MAIL_FROM=Гефест Завод <mapcontrol@exlibrum.ru>
MAIL_TO=admin@example.com
```

> **Следующий этап:** два получателя — `MAIL_TO` (очередь для админки) и `MAIL_NOTIFY` (личное уведомление).

---

## Как это работает

```mermaid
flowchart LR
  OP[Оператор] -->|черновик| DRAFT[(submissions/draft)]
  DRAFT -->|LLM check| LLM[Qwen 3.5 Flash]
  DRAFT -->|submit| PENDING[(submissions/pending)]
  PENDING -->|email + attachments| EMAIL[📧 admin]
  EMAIL --> ADM[Администратор]
  ADM -->|publish| SITE[Zavodsvay-Static<br/>map.json · assets · pages]
```

1. Оператор вводит заголовок, описание, координаты и добавляет фото.
2. Нажимает **«Проверить»** — LLM предлагает исправленный текст и warnings.
3. Оператор принимает правки или оставляет свой вариант.
4. Нажимает **«Отправить»** — заявка сохраняется в `pending`, администратор получает письмо с JSON и фото.

---

## Технологии

| Область | Решение |
|---------|---------|
| **Runtime** | Node.js + Express |
| **Фронт** | Локальный browser UI без тяжёлого framework |
| **Карта** | [Яндекс.Карты JS API v3](https://yandex.ru/dev/maps/) |
| **Изображения** | `sharp`, конвертация в WebP |
| **LLM** | OpenAI-compatible API, текущий провайдер — RouterAI |
| **Модель** | `qwen/qwen3.5-flash-02-23` |
| **Email** | `nodemailer` v8, SMTP через biz.mail.ru |
| **Хранение** | JSON + файловая структура `data/submissions/*` |
| **Интеграция** | Публикация в [Zavodsvay-Static](https://github.com/AlexanderKuzikov/Zavodsvay-Static) на следующем этапе |

---

## Структура репозитория

```text
MapControl/
├── CONTEXT.md
├── README.md
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── src/
│   ├── prompts/
│   │   └── check-text.txt
│   └── server.js
├── data/
│   └── submissions/
│       ├── draft/
│       ├── pending/
│       └── archive/
└── .env.example
```

---

## Планы

- [ ] Два получателя email: `MAIL_TO` (очередь для машинного парсинга) + `MAIL_NOTIFY` (личное уведомление)
- [ ] Вынести отправку письма в fire-and-forget / outbox, чтобы SMTP-сбой не ломал submit
- [ ] Админский контур: список pending-заявок, просмотр, категория, кадрирование, publish
- [ ] Экспорт в формат, совместимый с `Zavodsvay-Static`
- [ ] Явный лог latency LLM на сервере для мониторинга деградации провайдера

---

## Связанные проекты

| Проект | Роль |
|--------|------|
| [**Zavodsvay-Static**](https://github.com/AlexanderKuzikov/Zavodsvay-Static) | Сайт завода «Гефест», источник боевых данных `data/map.json` |
| [**MapControl**](https://github.com/AlexanderKuzikov/MapControl) | Локальный контур ввода и модерации новых объектов |

---

## Лицензия

[Apache License 2.0](LICENSE)
