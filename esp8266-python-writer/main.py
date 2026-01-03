from machine import Pin, I2C, SoftSPI, reset, freq, PWM
import time, network, urequests, json, gc, ubinascii, usocket

# Overclock 160MHz
freq(160000000)

# Hardware Config
SCL, SDA = 12, 14
SCK, MOSI, MISO = 14, 13, 12
CS, RST = 15, 2
BUZZER_PIN = 5 # GPIO 5 (D1)
DEVICE_ID = ubinascii.hexlify(network.WLAN().config('mac')).decode()

# Global State
current_mode = "RECORDER"
target_client = "default"
tag_count = 0
last_sync = 0
last_oled_update = 0
last_toggle_val = -1
BASE_API = ""
LOCAL_IP = "0.0.0.0"
is_online = False

# Drivers
from lib.ssd1306 import SSD1306_I2C
from lib.mfrc522 import MFRC522

# Initialize I2C once
i2c = I2C(scl=Pin(SCL), sda=Pin(SDA), freq=400000)
oled = SSD1306_I2C(128, 64, i2c)

# Initialize SPI once
spi = SoftSPI(baudrate=1000000, sck=Pin(SCK), mosi=Pin(MOSI), miso=Pin(MISO))
rfid = MFRC522(spi, gpioRst=RST, gpioCs=CS)

buzzer = PWM(Pin(BUZZER_PIN), duty=0)

def beep(freq_hz, duration_ms):
    try:
        buzzer.freq(freq_hz)
        buzzer.duty(512)
        time.sleep_ms(duration_ms)
        buzzer.duty(0)
    except: pass

def update_oled(l1, l2="", l3="", force=False):
    global last_oled_update, last_toggle_val
    curr_time = time.time()
    toggle_val = (curr_time // 4) % 2
    
    # Only update if forced or if content/toggle changes
    if not force and last_toggle_val == toggle_val and (curr_time - last_oled_update < 0.5):
        return

    try:
        oled.fill(0)
        status_txt = "ON" if is_online else "OFF"
        oled.text("OneTapGo [{}]".format(status_txt), 0, 0)
        oled.hline(0, 10, 128, 1)
        oled.text(l1[:16], 0, 14)
        oled.text(l2[:16], 0, 25)
        oled.text(l3[:16], 0, 36)
        oled.text("Tags Count: {}".format(tag_count), 0, 48)
        
        if toggle_val == 0:
            oled.text("IP: {}".format(LOCAL_IP), 0, 57)
        else:
            wlan_sta = network.WLAN(network.STA_IF)
            ssid = "OFFLINE"
            if wlan_sta.active():
                try: ssid = wlan_sta.config('essid')
                except: ssid = "ERROR"
            oled.text("WiFi: {}".format(ssid[:10]), 0, 57)
            
        oled.show()
        last_oled_update = curr_time
        last_toggle_val = toggle_val
        # Re-init RFID after I2C use because they share pins
        rfid.init()
    except: pass

def handle_http_request(s):
    try:
        s.settimeout(0.001)
        cl, addr = s.accept()
        req = cl.recv(1024).decode()
        if "GET /save" in req:
            with open('config.json', 'r') as f: conf = json.load(f)
            params = req.split('?')[1].split(' ')[0]
            for p in params.split('&'):
                k, v = p.split('=')
                conf[k if k != 'api' else 'url'] = v.replace('%3A', ':').replace('%2F', '/')
            with open('config.json', 'w') as f: json.dump(conf, f)
            cl.send('HTTP/1.1 200 OK\n\nOK')
            cl.close()
            reset()
        cl.close()
    except: pass

def sync_cloud():
    global current_mode, target_client, is_online
    try:
        res = urequests.get("{}/sync?deviceId={}".format(BASE_API, DEVICE_ID), timeout=3)
        data = res.json()
        current_mode = data.get('mode', 'RECORDER')
        target_client = data.get('target_client_slug', 'default')
        res.close()
        is_online = True
        return True
    except: 
        is_online = False
        return False

def report_event(uid, success):
    try:
        payload = {
            "device_id": DEVICE_ID, "uid": uid,
            "action": "TAG_WRITTEN", "mode_executed": current_mode, "success": success
        }
        urequests.post("{}/event".format(BASE_API), json=payload, timeout=3).close()
    except: pass

def write_ndef_url(rfid_obj, uid, url):
    try:
        prefix_code = 0x04 if url.startswith("https://") else 0x01
        addr_str = url.split("://")[1] if "://" in url else url
        payload = bytearray(addr_str, 'utf-8')
        payload_len = len(payload) + 1
        ndef = bytearray([0x03, payload_len + 4, 0xD1, 0x01, payload_len, 0x55, prefix_code]) + payload + bytearray([0xFE])
        while len(ndef) % 16 != 0: ndef.append(0)
        if rfid_obj.auth(0x60, 4, [0xFF]*6, uid) == rfid_obj.OK:
            for i in range(len(ndef) // 16):
                if rfid_obj.write(4 + i, list(ndef[i*16 : (i+1)*16])) != rfid_obj.OK: return False
            rfid_obj.stop_crypto1()
            return True
        return False
    except: return False

# Boot
try:
    with open('config.json', 'r') as f: config_data = json.load(f)
    BASE_API = config_data['url']
    WIFI_SSID = config_data['wifi_ssid']
    WIFI_PASS = config_data['wifi_pass']
except: 
    BASE_API = "https://wasser-c430a.web.app/api/device"
    WIFI_SSID, WIFI_PASS = "WGNR", "radar123"

wlan = network.WLAN(network.WLAN.IF_STA); wlan.active(True)
update_oled("WiFi...", "Connecting...", force=True)
wlan.connect(WIFI_SSID, WIFI_PASS)
for _ in range(15):
    if wlan.isconnected(): 
        LOCAL_IP = wlan.ifconfig()[0]
        is_online = True
        break
    time.sleep(1)

sync_cloud()
update_oled("MODE: " + current_mode, target_client, "READY", force=True)
beep(880, 100); beep(1100, 100)

server_socket = usocket.socket()
server_socket.setsockopt(usocket.SOL_SOCKET, usocket.SO_REUSEADDR, 1)
server_socket.bind(('', 80)); server_socket.listen(1)

while True:
    handle_http_request(server_socket)
    
    # Sync periodically
    if time.time() - last_sync > 60:
        if sync_cloud(): 
            last_sync = time.time()
            update_oled("MODE: " + current_mode, target_client, "SYNCED", force=True)

    # Standard OLED update handles the IP/SSID toggle internally
    update_oled("MODE: " + current_mode, target_client, "READY")

    # MFRC522 Request
    (stat, t) = rfid.request(rfid.REQIDL)
    if stat == rfid.OK:
        (stat, uid) = rfid.anticoll()
        if stat == rfid.OK:
            uid_hex = "".join([f"{x:02x}" for x in uid]).upper()
            update_oled("WRITING...", uid_hex, force=True)
            success = False
            if current_mode == "RECORDER":
                target_url = "https://wasser-c430a.web.app/go/{}/{}".format(target_client, uid_hex)
                success = write_ndef_url(rfid, uid, target_url)
            else: success = True
            
            if success:
                tag_count += 1
                beep(1200, 150)
            else:
                beep(200, 400)
            
            report_event(uid_hex, success)
            update_oled("RESULT", "SUCCESS" if success else "ERROR", uid_hex, force=True)
            time.sleep(1.5)
            update_oled("MODE: " + current_mode, target_client, "READY", force=True)
            rfid.init()

    time.sleep_ms(10)
    gc.collect()
