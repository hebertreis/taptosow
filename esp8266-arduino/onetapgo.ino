#include <SPI.h>
#include <MFRC522.h>
#include <NdefMessage.h>
#include <NfcAdapter.h>

/**
 * CONFIGURAÇÃO DE HARDWARE - NodeMCU LoLin V3 (HW 364-A)
 * Conexões sugeridas:
 * RST  -> D1 (GPIO 5)
 * SS   -> D2 (GPIO 4)
 * MOSI -> D7 (GPIO 13)
 * MISO -> D6 (GPIO 12)
 * SCK  -> D5 (GPIO 14)
 * GND  -> GND
 * 3.3V -> 3.3V (Não use 5V!)
 */

#define SS_PIN 4   // GPIO 4 (D2)
#define RST_PIN 5  // GPIO 5 (D1)

MFRC522 mfrc522(SS_PIN, RST_PIN);
NfcAdapter nfc = NfcAdapter(&mfrc522); 

void setup() {
  Serial.begin(115200);
  delay(1000); 
  
  SPI.begin();
  
  Serial.println(F("\n========================================"));
  Serial.println(F("   ONETAPGO - SISTEMA DE GRAVACAO V2.2  "));
  Serial.println(F("        BY CRE8 TECNOLOGIA              "));
  Serial.println(F("========================================"));
  
  // Inicializa o leitor
  mfrc522.PCD_Init(); 
  
  // Ganho máximo da antena para evitar falhas de comunicação em tags Mifare 1K
  mfrc522.PCD_SetAntennaGain(mfrc522.RxGain_max);
  
  Serial.print(F("Status do Leitor RC522: "));
  mfrc522.PCD_DumpVersionToSerial();
  
  Serial.println(F("\nAguardando Tag para processar..."));
}

void loop() {
  yield(); // Evita reset do Watchdog do ESP8266

  // Verifica se uma tag foi aproximada
  if (nfc.tagPresent()) {
    Serial.println(F("\n----------------------------------------"));
    Serial.println(F("Tag detectada! Iniciando processamento..."));

    // 1. Tenta ler as informações da tag
    NfcTag tag = nfc.read();
    
    // CORREÇÃO: getTagType() retorna um inteiro (enum), não uma String.
    // 0 = Unknown, 5 = Mifare Classic, etc.
    int type = tag.getTagType();
    
    Serial.print(F("ID do Tipo Identificado: "));
    Serial.println(type);

    bool canWrite = false;

    // 2. Lógica de Identificação e Formatação
    // Se o tipo for 0 (TAG_TYPE_UNKNOWN), o cartão Mifare 1K precisa ser formatado para NDEF.
    if (type == 0) {
      Serial.println(F("Estado: Tag virgem ou nao NDEF. Tentando formatar..."));
      if (nfc.format()) {
        Serial.println(F("[OK] Tag formatada para NDEF com sucesso."));
        canWrite = true;
      } else {
        Serial.println(F("[ERRO] Falha na formatacao. Verifique se o chip esta trancado."));
      }
    } else {
      // Já é uma tag reconhecida (Mifare Classic formatada ou NTAG21x)
      Serial.println(F("Estado: Tag ja compativel com NDEF."));
      canWrite = true;
    }

    // 3. Execução da Gravação da URL/Texto
    if (canWrite) {
      Serial.println(F("Preparando gravacao OneTapGo..."));
      
      NdefMessage message = NdefMessage();
      
      // Adicionando os registros
      message.addUriRecord("https://onetapgo.site/a/esp8266"); 
      message.addTextRecord("OneTapGo By CRE8 Tecnologia");
      
      // O nfc.write() ja cuida de limpar o que existia antes
      if (nfc.write(message)) {
        Serial.println(F("[SUCESSO] Dados gravados com sucesso!"));
      } else {
        Serial.println(F("[FALHA] Erro ao gravar. Mantenha a Tag mais próxima."));
      }
    }

    Serial.println(F("Operacao finalizada."));
    Serial.println(F("RETIRE A TAG PARA CONTINUAR..."));

    // 4. Trava de segurança: Espera remover a tag
    while (nfc.tagPresent()) {
      delay(200);
      yield();
    }

    Serial.println(F("\nPronto para a proxima!"));
    
    // Reinicialização de segurança do leitor
    mfrc522.PCD_Init();
    mfrc522.PCD_SetAntennaGain(mfrc522.RxGain_max);
  }
}