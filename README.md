# Календарь ХК Сибирь (КХЛ)

Подписка на матчи Сибири для **Apple Calendar** (Mac / iPhone) и **Google Calendar**.

Файл обновляется автоматически из API КХЛ (примерно раз в 6 часов).

## Ссылка для подписки

```
https://raw.githubusercontent.com/karpenko-chernikov/sibir-calendar/main/sibir.ics
```

Или через jsDelivr (иногда надёжнее для Google):

```
https://cdn.jsdelivr.net/gh/karpenko-chernikov/sibir-calendar@main/sibir.ics
```

### iPhone / Mac (Календарь)

1. На Mac: **Файл → Новая подписка на календарь…**
2. На iPhone: **Настройки → Календарь → Учётные записи → Добавить учётную запись → Другое → Добавить календарь с подпиской**
3. Вставьте ссылку выше
4. Имя: «ХК Сибирь», обновление — автоматически

Или откройте на устройстве:

```
webcal://raw.githubusercontent.com/karpenko-chernikov/sibir-calendar/main/sibir.ics
```

### Google Calendar

1. [calendar.google.com](https://calendar.google.com) → слева **Другие календари** → **+** → **По URL**
2. Вставьте ссылку на `.ics`
3. Добавить календарь

События появятся с названием вида `Сибирь — Амур` / `Ак Барс — Сибирь`, местом проведения и пометкой дома/в гостях. Пока КХЛ не опубликовал точное время — матч на весь день («время ещё не объявлено»).

## Обновить вручную

```bash
node scripts/sync-ics.mjs
```
