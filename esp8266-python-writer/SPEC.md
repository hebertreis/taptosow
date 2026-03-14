OneTapGo - Technical Specification (v2.0)

Status: Draft / Approved for Dev
Context: MVP / PoC Infrastructure
Architecture Type: Cloud-Controlled IoT (Device Twin Pattern)

1. Visão Executiva

O objetivo é criar uma Infraestrutura de Provisionamento IoT onde o hardware (ESP8266) atua como um "Remote Worker" controlado por um Dashboard Web centralizado. Isso elimina a necessidade de reconfigurar fisicamente o gravador para cada novo cliente.

O Fluxo "Happy Path"

Admin: Acessa o Dashboard, seleciona "Cliente: RampChurch" e "Modo: Gravar".

Cloud: Atualiza o estado desejado do dispositivo no Firestore.

Dispositivo (ESP): Sincroniza a configuração, entra em modo de gravação e aguarda a tag.

Operação: Usuário aproxima a tag. ESP grava a URL, valida e envia o log de sucesso.

Admin: Vê o feedback "Sucesso" na tela em tempo real.

2. Arquitetura de Dados (Firebase Firestore)

O banco de dados é a fonte da verdade. Nenhuma lógica de negócio reside no ESP8266.

2.1. Collection: clients

Armazena os inquilinos do sistema.

Doc ID: slug (ex: rampchurchsp)

{
  "name": "The Ramp Church SP",
  "base_url": "[https://linktr.ee/rampchurchsp](https://linktr.ee/rampchurchsp)", // Destino padrão
  "active": true,
  "created_at": "Timestamp"
}


2.2. Collection: devices (Core do Controle Remoto)

Representa o estado físico e lógico dos gravadores.

Doc ID: device_id (ex: esp_station_01)

{
  "label": "Estação Principal",
  "status": "online", // Atualizado via heartbeat
  "last_seen": "Timestamp",
  
  // CONFIGURAÇÃO (Editado pelo Frontend Admin)
  "config": {
    "mode": "RECORDER", // Enum: [RECORDER, VALIDATOR, DEBUG]
    "target_client_slug": "rampchurchsp",
    "target_url_template": "[https://onetapgo.site/go/](https://onetapgo.site/go/){slug}/{uid}"
  },

  // FEEDBACK (Escrito pelo ESP via API)
  "live_feedback": {
    "last_uid": "04A1B2...",
    "last_result": "SUCCESS", // SUCCESS, ERROR, WRITE_FAIL
    "message": "Tag gravada e vinculada.",
    "timestamp": "Timestamp"
  }
}


2.3. Collection: tags

Inventário de hardware distribuído.

Doc ID: uid (ex: 04E25A...)

{
  "uid": "04E25A...",
  "client_slug": "rampchurchsp",
  "provisioned_by": "esp_station_01",
  "provisioned_at": "Timestamp",
  "batch_id": "lote_jan_2026",
  "status": "active",
  "redirect_override": null, // Se preenchido, ignora o client.base_url
  "scan_count": 0,
  "timestamp": "Timestamp"
}


3. Backend API (Cloud Functions)

O ESP8266 se comunica exclusivamente via HTTPS (REST).

3.1. GET /api/device/sync

Query Param: ?deviceId=MACADDRESS

Responsabilidade: Retornar a configuração atual.

Lógica:

Busca devices/{deviceId}.

Atualiza last_seen para now().

Retorna o objeto config.

3.2. POST /api/device/event

Responsabilidade: Processar o trabalho feito pelo ESP.

Payload:

{
  "device_id": "MACADDRESS",
  "device_label": "esp_station_01",
  "uid": "04E25A...",
  "action": "TAG_WRITTEN", // ou TAG_SCANNED (para validator/debug)
  "mode_executed": "RECORDER",
  "success": true
}


Lógica:

Se success == true e mode == RECORDER:

Cria/Atualiza documento na collection tags.

Atualiza devices/{deviceId}/live_feedback com o resultado (para o admin ver).

4. Firmware (ESP8266 + MicroPython)

O firmware deve implementar uma Máquina de Estados Finita.

Variáveis Globais (Voláteis)

current_config: Objeto JSON recebido da API.

Loop Principal (Pseudocódigo)

Boot: Conecta WiFi.

Sync (Heartbeat):

Faz GET /api/device/sync.

Atualiza current_config.

Atualiza OLED: Mostra Modo ("GRAVAR") e Cliente ("RampChurch").

Wait for Tag: Loop do RC522.

Tag Detectada:

IF mode == RECORDER:

Formata URL: https://onetapgo.site/go/rampchurchsp/{UID}.

Escreve NDEF na Tag.

POST /api/device/event (Registra sucesso/falha).

IF mode == VALIDATOR:

Lê NDEF.

Verifica se URL contém rampchurchsp.

POST /api/device/event (Registra validação).

IF mode == DEBUG:

Lê dumps da memória.

POST /api/device/event (Envia dados brutos).

Feedback: Mostra resultado no OLED por 2 segundos.

Volta para o passo 2.

5. Frontend Admin (Provisioning Dashboard)

Aplicação Web (React/Next.js) para uso interno da equipe OneTapGo.

Funcionalidades

Seletor de Dispositivo: Dropdown listando dispositivos online.

Painel de Controle (Esquerda):

Select: Cliente (ex: Ramp Church).

Radio: Modo (Gravar / Validar / Debug).

Botão: "Aplicar Configuração" -> Escreve no Firestore devices/{id}/config.

Live Monitor (Direita):

Ouve (onSnapshot) o documento devices/{id}.

Exibe Card Gigante: Última Tag Processada.

Cor de Fundo: Verde (Sucesso) ou Vermelho (Erro).

6. Frontend Público (Redirect Engine)

A rota que o usuário final acessa.

Rota: /go/[slug]/[uid]

Lógica Server-Side:

Recebe request: .../go/rampchurchsp/04E25A...

Firestore Lookup: Busca tag 04E25A....

Fallback: Se tag não existe, assume que é válida mas não cadastrada (devido ao slug na URL) e loga como "Unregistered Scan".

Decisão de Destino:

Tem redirect_override? Usa ele.

Não tem? Busca clients/rampchurchsp e usa base_url.

Async Analytics: Incrementa contador + Loga User Agent/IP.

HTTP 302 Redirect: Envia usuário para o destino.

7. Roadmap de Desenvolvimento (Sprint Tática)

Dia 1: Setup Backend

Criar Projeto Firebase.

Criar estrutura das coleções (Firestore).

Deploy das Cloud Functions (sync e event).

Dia 2: Firmware Core

ESP conecta WiFi e faz GET na API.

ESP implementa lógica de RECORDER (RC522 Write).

Dia 3: Frontend Admin & Integração

Tela simples para mudar o JSON de config no Firestore.

Teste ponta a ponta: Muda config na web -> ESP muda OLED.

Dia 4: Redirect Engine

Rota /go/... funcionando e redirecionando.

OneTapGo Engineering Team