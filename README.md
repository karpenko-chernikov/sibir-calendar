# Календарь ХК Сибирь (КХЛ)

Подписка на матчи Сибири для **Apple Calendar** (Mac / iPhone) и **Google Calendar**.

## Ссылка для подписки

```
https://raw.githubusercontent.com/karpenko-chernikov/sibir-calendar/main/sibir.ics
```

### iPhone / Mac

- Mac: **Файл → Новая подписка на календарь…**
- iPhone: **Настройки → Календарь → Учётные записи → Другое → Добавить календарь с подпиской**
- Или: `webcal://raw.githubusercontent.com/karpenko-chernikov/sibir-calendar/main/sibir.ics`

### Google Calendar

**Другие календари → + → По URL** → вставить ссылку выше.

## Автообновление

На этом Mac стоит LaunchAgent `com.nikita.sibir-calendar-sync`: каждые **6 часов** тянет расписание из API КХЛ и обновляет `sibir.ics` на GitHub.

Когда КХЛ опубликует точное время матча, оно попадёт в файл при следующей синхронизации. Apple / Google подтянут изменения сами (обычно в течение нескольких часов).

Лог: `~/Library/Logs/sibir-calendar-sync.log`

Вручную:

```bash
./scripts/auto-sync.sh
```

Пока время не объявлено — матч на весь день. После появления времени событие станет с конкретным часом (часовой пояс `Asia/Novosibirsk`).
