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

На этом Mac стоит LaunchAgent `com.nikita.sibir-calendar-sync`: каждые **6 часов** берёт расписание с khl.ru (точное время МСК) и API КХЛ (счета, форма) и обновляет `sibir.ics` на GitHub.

Apple / Google подтягивают изменения сами (обычно в течение нескольких часов). В карточке матча: форма текущего сезона (🟢 победа, 🔴 поражение, ⚪ ещё не сыграно) с соперником и счётом, плюс личные встречи сезона.

Лог: `~/Library/Logs/sibir-calendar-sync.log`

Вручную:

```bash
./scripts/auto-sync.sh
```

Пока время не объявлено — матч на весь день. После появления времени событие станет с конкретным часом (часовой пояс `Asia/Novosibirsk`).
