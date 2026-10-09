# Origem do cadastro no app

API de atribuição que leva uma origem em um token opaco, sem depender de Referer. O servidor registra abertura, toques e cadastro em SQLite e retorna uma decisão auditável.

## Requisitos e execução

Requer Node.js 24.12 ou mais recente e npm. Essa é a versão mínima declarada em package.json.

~~~sh
npm ci
npm test
npm run typecheck
npm start
~~~

O servidor escuta em http://localhost:3000. GET /health retorna {"status":"ok"}. O banco padrão é data/attribution.sqlite. Configure PORT, PUBLIC_BASE_URL ou DATABASE_PATH para alterar esses valores.

## Fluxo

1. O parceiro cria um link com POST /links. source aceita campaign, referral ou community; reference_id identifica a campanha, indicação ou comunidade.
2. A cada clique, o parceiro chama POST /clicks com link_id e click_id. A resposta contém um touch_token opaco, open_url e deep_link. Abrir open_url redireciona ao deep link; isso não cria outro toque.
3. Na primeira abertura, o app chama POST /app/first-open com installation_id e salva a resposta. Para cada token recebido, envia POST /app/touches. Antes do cadastro, envia os tokens pendentes e chama POST /signups com signup_id estável e installation_id.
4. Consulte a decisão em GET /signups/:signup_id/attribution.

Repetir o mesmo click_id para o mesmo link retorna o mesmo token. Usar esse click_id em outro link retorna 409. A ingestão repetida do mesmo token na mesma instalação também é idempotente.

## Exemplos

Crie um link de campanha ou de indicação:

~~~http
POST /links
Content-Type: application/json

{"source":"campaign","reference_id":"tiktok-outubro-2026"}
~~~

~~~http
POST /links
Content-Type: application/json

{"source":"referral","reference_id":"creator-42"}
~~~

Resposta de criação:

~~~json
{
  "link_id": "<link-id>",
  "source": "campaign",
  "reference_id": "tiktok-outubro-2026",
  "click_endpoint": "http://localhost:3000/clicks"
}
~~~

Emita um token para um clique:

~~~http
POST /clicks
Content-Type: application/json

{"link_id":"<link-id>","click_id":"click-tiktok-001"}
~~~

~~~json
{
  "link_id": "<link-id>",
  "click_id": "click-tiktok-001",
  "touch_token": "<token-opaco>",
  "deep_link": "conty://open?touch=<token-opaco>",
  "open_url": "http://localhost:3000/open?touch=<token-opaco>",
  "idempotent": true
}
~~~

Trecho da auditoria de um cadastro com dois toques:

~~~json
{
  "attribution_type": "referral",
  "selected_touch_token": "<token-do-criador>",
  "reason": "LAST_VALID_TOUCH",
  "touches": [
    {
      "touch_token": "<token-da-campanha>",
      "eligible": true,
      "selected": false,
      "reasons": ["SUPERSEDED_BY_LATER_TOUCH"]
    },
    {
      "touch_token": "<token-do-criador>",
      "eligible": true,
      "selected": true,
      "reasons": ["LAST_VALID_TOUCH"]
    }
  ],
  "later_touches": []
}
~~~

## Regra e limites

A política LAST_VALID_TOUCH usa uma janela fixa inclusiva de 168 horas a partir da primeira abertura registrada pelo servidor. O cadastro também precisa ocorrer dentro dela. Vence o toque válido mais recente; em empate, vence a maior sequência persistida. Toques recebidos depois do cadastro aparecem em later_touches e não recalculam a decisão. Sem toque válido, a origem é organic, com motivo NO_VALID_TOUCH ou SIGNUP_AFTER_WINDOW.

O horário do toque é quando o servidor aceita POST /app/touches, não quando o clique foi emitido. O fluxo precisa de conexão para registrar a primeira abertura e enviar toques; não reconstrói horários offline. A API de demonstração não autentica usuários.

Limitações auditadas, mantidas nesta entrega:

- O helper resolve timestamps equivalentes por instante, mas detecta o motivo de empate comparando as strings. Se os mesmos instantes forem escritos com offsets diferentes, a sequência maior ainda vence, mas a auditoria pode informar LAST_VALID_TOUCH e SUPERSEDED_BY_LATER_TOUCH em vez dos motivos de empate. O fluxo HTTP normaliza horários para UTC.
- JSON malformado em uma requisição pode resultar em 500, não 400. A leitura do corpo falha antes de qualquer gravação.

## Uso de IA e revisão

Codex escreveu a implementação, os testes e esta documentação. Uma sessão separada do Codex fez revisão técnica somente leitura do snapshot e registrou os limites acima. Na preparação, a pessoa responsável filtrou instruções externas ao escopo, definiu critérios e checkpoints, acompanhou as evidências e autorizou a publicação; isso não declara revisão humana linha a linha do código.
