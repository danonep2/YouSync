# YouSync

Extensão para Chrome + servidor WebSocket para **sincronizar a reprodução do
YouTube** entre várias pessoas, em tempo real (watch party).

Uma pessoa é o **host** e controla a reprodução (play/pause/seek/velocidade) e a
troca de vídeo; os demais participantes recebem e replicam tudo automaticamente.
Se **qualquer** participante (host incluso) cair em um anúncio, **todos pausam**
até o anúncio acabar, e a extensão avisa quem está vendo o anúncio.

## Estrutura

```
yousync/
├── server/      # Servidor WebSocket (Node + ws), salas em memória
└── extension/   # Extensão Chrome (Manifest V3, JavaScript puro)
```

## Funcionalidades

- Salas **públicas** (aparecem numa lista) ou **privadas** (código de 6 caracteres).
- Criador da sala é o **host**; pode **transferir o host** para outro participante.
- Se o host sai, o próximo participante é **promovido automaticamente**.
- Sincronização completa: estado de reprodução **e** troca de vídeo.
- **Controles compartilhados** (opcional): qualquer participante controla a
  reprodução (play/pause/seek/velocidade), mas **só o host troca o vídeo**.
  Pode ser definido ao criar a sala e ligado/desligado pelo host a qualquer hora.
- **Troca de vídeo sincronizada**: ao trocar, **todos iniciam pausados**; o
  servidor só dispara o play quando **todos** tiverem o novo vídeo carregado
  (com timeout de segurança de 12s). Elimina o atraso de quem carrega mais devagar.
- **Pausa por anúncio**: quem está com o anúncio **continua reproduzindo** (para
  assistir/pular); os demais pausam e o popup identifica quem recebeu o anúncio.
  Quando o anúncio termina/é pulado, todos retornam juntos.
- A extensão **não inicia sozinha** no YouTube — o usuário ativa pelo popup.

## 1. Servidor

Requer Node.js 18+.

```bash
cd server
npm install
npm run dev        # ou: npm start
```

Sobe em `http://localhost:8080` (HTTP de status + WebSocket no mesmo host/porta).
A porta pode ser alterada via variável de ambiente `PORT` (veja `.env.example`).

- `GET /health` → `{ "status": "ok", "rooms": <n> }`
- `GET /admin` → painel de administração (requer a variável `ADMIN_TOKEN`; o token é pedido na página).
  Mostra clientes conectados, clientes em sala, salas abertas/criadas e o consumo do processo
  (CPU, memória, atraso do event loop, histórico dos últimos 10 min). Salas privadas aparecem só como
  contagem — sem nome, código, vídeo ou participantes.
- `GET /admin/api/stats` → os mesmos dados em JSON (`Authorization: Bearer <ADMIN_TOKEN>`).

## 2. Extensão

1. Acesse `chrome://extensions`.
2. Ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e selecione a pasta `extension/`.

## 3. Uso

1. Abra um vídeo no YouTube.
2. Clique no ícone do YouSync.
3. Informe o endereço do servidor (padrão `ws://localhost:8080`) e clique em
   **Ativar YouSync**.
4. Defina um **apelido** e então:
   - **Criar sala** (vira host), ou
   - **Entrar** em uma sala pública da lista ou por **código**.
5. Como host, controle o vídeo normalmente — os demais sincronizam. Para passar
   o controle, use **tornar host** ao lado do participante.

## Arquitetura (resumo)

- **server/src/index.js** — HTTP de status + `WebSocketServer`, heartbeat.
- **server/src/rooms.js** — `RoomManager`: salas, host, código, estado e o
  conjunto de usuários em anúncio (`adUsers`).
- **server/src/handlers.js** — roteamento das mensagens e broadcast por sala.
- **server/src/protocol.js** / **extension/shared/protocol.js** — tipos de
  mensagem (mantidos em sincronia entre os dois lados).
- **extension/background.js** — service worker: única conexão WebSocket, estado
  da sessão, reconexão automática e roteamento popup ↔ servidor ↔ content script.
- **extension/content.js** — injetado no YouTube: observa o player (host),
  replica ações (participante) e detecta anúncios (todos).
- **extension/popup/** — UI (ativar, criar/entrar, sala, participantes, host).

## Notas

- Salas vivem **em memória** — reiniciar o servidor apaga todas. Sem login/banco.
- Sem Docker nesta etapa.
- Para produção, hospede o servidor com `wss://` e ajuste o endereço no popup.
