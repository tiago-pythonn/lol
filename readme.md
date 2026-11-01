# Zacord

## Executar

Instale o Node.js 18 ou superior e, no PowerShell, execute:

```powershell
cd "C:\Users\ADM\Downloads\html\zacord"
node server.js
```

Abra `http://localhost:3000`. Crie uma conta, compartilhe seu username e adicione outras pessoas para iniciar conversas. As mensagens são atualizadas automaticamente enquanto o app está aberto.

Contas, conversas e mensagens ficam em `data.json`, criado ao lado de `server.js`. As senhas são armazenadas com hash; sessões ativas são encerradas quando o servidor reinicia.

Por padrão, o servidor aceita conexões somente deste computador. Para testar em uma rede local confiável, defina `ZACORD_HOST=0.0.0.0` antes de iniciar e acesse pelo IP do computador que está executando o servidor. Não exponha o servidor diretamente à internet: configure HTTPS antes de aceitar conexões externas.


## Netlify

Na Netlify, o site estático fica em `public/` e a API (`/api/*`) roda como uma Netlify Function em `netlify/functions/api.ts`. Contas, sessões, conversas e mensagens ficam no Netlify Database (Postgres), com o esquema em `db/schema.ts`. As migrações em `netlify/database/migrations/` são aplicadas automaticamente a cada deploy.
