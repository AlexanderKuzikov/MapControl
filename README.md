<p align="center">
  <a href="https://nodejs.org/"><img alt="Node" src="https://img.shields.io/badge/Node-24+-339933?logo=node.js&logoColor=white"></a>
  <a href="https://expressjs.com/"><img alt="Express 5" src="https://img.shields.io/badge/Express-5.x-000000?logo=express&logoColor=white"></a>
  <a href="https://yandex.ru/dev/maps/"><img alt="Yandex Maps" src="https://img.shields.io/badge/Maps-Yandex_v3-FF0000?logo=yandex&logoColor=white"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg"></a>
</p>

<h1 align="center">MapControl</h1>
<p align="center">Локальный конструктор заявок на объекты карты для zavodsvay.ru</p>

---

Операторский инструмент для безопасного добавления объектов на карту выполненных работ. Оператор собирает данные и фото, LLM выравнивает текст и определяет категорию, заявка отправляется на email администратора для модерации.

- **LLM-нормализация** — Qwen 3.5 Flash: текст, категория (из 9), количество свай
- **Yandex Maps v3** — выбор точки на карте или ручной ввод координат
- **Sharp → WebP** — конвертация фото при загрузке
- **Email-транспорт** — nodemailer (Gmail / корпоративная / Yandex / mail.ru)
- **Vanilla JS SPA** — без фреймворков, локальный шрифт Inter
- **Windows-first** — start.vbs launcher, авто-порт, desktop shortcuts

## Быстрый старт

```bash
git clone https://github.com/AlexanderKuzikov/MapControl.git
cd MapControl
npm install
cp .env.example .env   # SMTP + LLM keys

npm start              # http://127.0.0.1:<auto-port>
```

## Документация

- [`docs/CONTEXT.md`](docs/CONTEXT.md) — состояние проекта
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — архитектурные решения

## Статус

**MVP** — операторский контур работает: форма, карта, фото, LLM, email.

## Лицензия

[Apache-2.0](LICENSE) © Alexander Kuzikov
