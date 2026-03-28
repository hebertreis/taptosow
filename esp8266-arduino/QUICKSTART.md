# OneTapGo ESP8266 5.1.0 - Quick Start

## 1. Build

```bash
pio run -e nodemcuv2
```

## 2. Upload

```bash
pio run -e nodemcuv2 -t upload
```

Se o upload falhar:

1. pressione `FLASH`;
2. pressione `RST`;
3. solte `RST`;
4. solte `FLASH`;
5. tente novamente.

## 3. Configurar Wi-Fi

Ao ligar:

- se ja houver Wi-Fi salvo, o dispositivo tenta conectar;
- se nao houver, ele abre o AP `OneTapGo_XXXXXX`;
- senha do AP: `onetapgo123`.

Depois:

1. conecte no AP do dispositivo;
2. abra `192.168.4.1`;
3. escolha a rede;
4. salve e aguarde reconexao.

Tambem e possivel abrir o portal:

- segurando o botao `FLASH` por `5s`;
- ou por MQTT com `wifi_portal`.

## 4. Admin

Abra:

```text
https://onetapgo.site/admin
```

Use no software admin o `deviceId` mostrado no display.

## 5. Botao FLASH

- `1 toque`: leitura NFC
- `2 toques`: tela admin
- `3 toques`: tela tecnica
- `5s pressionado`: portal Wi-Fi

## 6. MQTT

Base:

```text
onetapgo/{deviceId}
```

Topicos principais:

- `/command`
- `/status`
- `/heartbeat`
- `/result`

Comandos principais:

- `write`
- `read`
- `wifi_scan`
- `wifi_set`
- `wifi_reset`
- `wifi_portal`

## 7. Verificacao rapida

No serial monitor, valide:

- versao `5.1.0`;
- `deviceId`;
- Wi-Fi conectado;
- MQTT conectado;
- RC522 inicializado.

No hardware, valide:

- tela idle amigavel;
- LED azul piscando em trafego MQTT;
- LED azul aceso durante leitura NFC;
- botao FLASH respondendo aos quatro gestos.
