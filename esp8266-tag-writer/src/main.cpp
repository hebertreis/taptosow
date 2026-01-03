#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Arduino.h>
#include <MFRC522.h>
#include <NfcAdapter.h>
#include <SPI.h>
#include <Wire.h>

// Configurações do OLED (HW-364A)
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define SCREEN_ADDRESS 0x3C
#define OLED_SCL 14 // D5
#define OLED_SDA 12 // D6

// Configurações do RFID-RC522
#define RST_PIN 2 // D4
#define SS_PIN 15 // D8

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
MFRC522 mfrc522(SS_PIN, RST_PIN);
NfcAdapter nfc = NfcAdapter(mfrc522);

void updateDisplay(String msg1, String msg2 = "") {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 10);
  display.println("OneTapGo - Writer");
  display.drawLine(0, 22, 128, 22, SSD1306_WHITE);

  display.setCursor(0, 35);
  display.setTextSize(1);
  display.println(msg1);

  if (msg2 != "") {
    display.setCursor(0, 50);
    display.println(msg2);
  }

  display.display();
}

void setup() {
  Serial.begin(115200);

  // Inicializa I2C nos pinos específicos da HW-364A
  Wire.begin(OLED_SDA, OLED_SCL);

  if (!display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS)) {
    Serial.println(F("Falha ao iniciar OLED"));
    for (;;)
      ;
  }

  updateDisplay("Iniciando RFID...");

  // Inicializa SPI e RC522
  SPI.begin();
  mfrc522.PCD_Init();

  updateDisplay("Aproxime a Tag", "Aguardando...");
  Serial.println("Sistema pronto. Aproxime a Tag.");
}

String getUidString(byte *uid, byte size) {
  String uidStr = "";
  for (byte i = 0; i < size; i++) {
    uidStr += String(uid[i] < 0x10 ? "0" : "");
    uidStr += String(uid[i], HEX);
  }
  uidStr.toUpperCase();
  return uidStr;
}

void loop() {
  // Verifica se há uma nova tag
  if (nfc.tagPresent()) {
    updateDisplay("Lendo Tag...", "Não remova");

    NfcTag tag = nfc.read();
    String uid = tag.getUidString();
    uid.replace(" ", ""); // Limpa espaços do UID

    String targetUrl = "https://onetapgo.site/v2?TAGID=" + uid;

    Serial.print("Tag detectada: ");
    Serial.println(uid);
    Serial.print("Gravando URL: ");
    Serial.println(targetUrl);

    updateDisplay("Gravando...", uid);

    NdefMessage message = NdefMessage();
    message.addUriRecord(targetUrl);

    bool success = nfc.write(message);

    if (success) {
      updateDisplay("SUCESSO!", "URL Gravada");
      Serial.println("Escrita concluída com sucesso!");
    } else {
      updateDisplay("ERRO NA GRAVACAO", "Tente novamente");
      Serial.println("Falha ao gravar a tag.");
    }

    delay(3000);
    updateDisplay("Aproxime a Tag", "Aguardando...");
  }
  delay(500);
}
