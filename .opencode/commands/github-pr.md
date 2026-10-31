---
description: Проверить GitHub или подготовить draft PR в root без merge и deploy
---

Работай на русском. Прочитай AGENTS.md, .opencode-project/PROJECT_CONTEXT.md
и docs/GITHUB_WORKFLOW.md. Проверь git status и фактические изменения.
Запрос пользователя: $ARGUMENTS

Без аргументов выполни только node tools/github-pr.cjs check и plan.
Не считай эту команду разрешением на изменения приложения, push или создание PR.
Для явно запрошенного PR используй tools/github-pr.cjs create после проверок,
коммита и разрешённого push. Описание должно включать файлы, причину,
фактические проверки и риски. Не дублируй PR #73. Не выполняй merge,
deploy, force push и изменения данных. Не показывай секреты.
