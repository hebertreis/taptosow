/**
 * @file status_led_manager.cpp
 * @brief Built-in status LED manager implementation
 */

#include "managers/status_led_manager.h"

#include "config/hardware_config.h"

StatusLedManager g_statusLed;

void StatusLedManager::begin() {
    pinMode(STATUS_LED_PIN, OUTPUT);
    _initialized = true;
    _holdEnabled = false;
    _ledOn = false;
    _pendingTransitions = 0;
    _lastTransitionAt = 0;
    _apply(false);
}

void StatusLedManager::loop() {
    if (!_initialized) {
        return;
    }

    if (_holdEnabled) {
        if (!_ledOn) {
            _apply(true);
        }
        return;
    }

    if (_pendingTransitions == 0) {
        if (_ledOn) {
            _apply(false);
        }
        return;
    }

    const unsigned long now = millis();
    if (_lastTransitionAt != 0 && (now - _lastTransitionAt) < STATUS_LED_BLINK_MS) {
        return;
    }

    _apply(!_ledOn);
    _lastTransitionAt = now;
    --_pendingTransitions;
}

void StatusLedManager::signalActivity() {
    if (!_initialized || _holdEnabled) {
        return;
    }

    _pendingTransitions = 2;
    _lastTransitionAt = 0;
}

void StatusLedManager::setHold(bool enabled) {
    if (!_initialized) {
        return;
    }

    _holdEnabled = enabled;
    if (enabled) {
        _pendingTransitions = 0;
        _lastTransitionAt = 0;
        _apply(true);
    } else if (_ledOn) {
        _apply(false);
    }
}

void StatusLedManager::_apply(bool enabled) {
    digitalWrite(STATUS_LED_PIN, enabled ? STATUS_LED_ACTIVE : STATUS_LED_INACTIVE);
    _ledOn = enabled;
}
