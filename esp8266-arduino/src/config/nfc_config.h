/**
 * @file nfc_config.h
 * @brief NFC configuration for OneTapGo ESP8266
 */

#ifndef NFC_CONFIG_H
#define NFC_CONFIG_H

// ============================================================================
// NFC Tag Configuration
// ============================================================================
#define SECTOR_COUNT        16      // Number of sectors for 1K cards
#define NFC_DEFAULT_KEY     0xFF    // Default MIFARE key byte (0xFFFFFFFFFFFF)

// ============================================================================
// NFC Timing
// ============================================================================
#define NFC_INIT_DELAY_MS       500   // Delay after RC522 init
#define NFC_TAG_DETECT_DELAY_MS 10    // Delay after tag detection
#define NFC_WRITE_TIMEOUT_MS    5000  // Write operation timeout
#define NFC_READ_TIMEOUT_MS     3000  // Read operation timeout

// ============================================================================
// NFC Wait Timeout (when waiting for tag)
// ============================================================================
// Time to wait for a tag to appear before timeout
#define NFC_WAIT_TIMEOUT_MS     30000  // 30 seconds waiting for tag
#define NFC_WARNING_BEFORE_MS   5000   // Warn 5 seconds before timeout

// ============================================================================
// NDEF Configuration
// ============================================================================
#define NDEF_MAX_RECORDS    4       // Maximum NDEF records to read
#define NDEF_MAX_PAYLOAD_LEN 256    // Maximum payload length

// ============================================================================
// RC522 Antenna Gain
// ============================================================================
// Use maximum gain for better range
#define RC522_ANTENNA_GAIN  RxGain_max

#endif // NFC_CONFIG_H
