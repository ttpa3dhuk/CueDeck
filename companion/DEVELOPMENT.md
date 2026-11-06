# Сборка страниц Companion

Файл собирается скриптом из той же таблицы переменных, что использует CueDeck:

```bash
npx vite-node companion/build.ts
```

Раскладка и подписи — `companion/build.ts`; переменные — `src/main/remote/companion-vars.ts`; отправка из CueDeck — `src/main/remote/companion-push.ts`. Формат — экспорт Companion 5.0.6 (JSON, version 12). В Companion 5 кегль текста — **% от высоты элемента**: подписи 25–36, иначе «Shrink to fit» режет слова пополам.

