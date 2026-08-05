import os
import time
import urllib.request
import json
import traceback
import sys
import shutil
import subprocess

# === AUTO-INSTALAÇÃO DE DEPENDÊNCIAS ===
def ensure_dependencies():
    missing_pkgs = []
    
    try:
        import yt_dlp
    except ImportError:
        missing_pkgs.append("yt-dlp")
        
    if not shutil.which("ffmpeg"):
        try:
            import imageio_ffmpeg
        except ImportError:
            missing_pkgs.append("imageio-ffmpeg")
            
    try:
        import websocket
    except ImportError:
        missing_pkgs.append("websocket-client")
            
    if missing_pkgs:
        print(f"Buscando dependências ausentes: {', '.join(missing_pkgs)}...")
        subprocess.run([sys.executable, "-m", "pip", "install", *missing_pkgs], check=True)

ensure_dependencies()
# ========================================

# Importa os nossos novos módulos dedicados
from download_video import download_youtube_video
from editor_video import cut_video

WORKER_URL = "https://blue-unit-2872.michelslvnqs.workers.dev"
DOWNLOAD_DIR = "downloads"

os.makedirs(DOWNLOAD_DIR, exist_ok=True)

def fetch_subtitles_info(youtube_id):
    import yt_dlp
    ydl_opts = {
        'quiet': True,
        'skip_download': True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        try:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={youtube_id}", download=False)
            subs = []
            added = set()
            
            manual = info.get('subtitles', {})
            for lang in manual:
                subs.append({"code": lang, "name": f"{lang.upper()} (Oficial)"})
                added.add(lang)
                
            auto = info.get('automatic_captions', {})
            for lang in auto:
                if lang not in added:
                    subs.append({"code": lang, "name": f"{lang.upper()} (Auto)"})
                    
            return subs
        except:
            return []

# get_next_job removido (usando WebSockets agora)

def update_job_status(job_id, status, title=None, error_msg=None):
    try:
        data = {"status": status}
        if title is not None:
            data["title"] = title
        if error_msg is not None:
            data["error_msg"] = error_msg
            
        json_data = json.dumps(data).encode('utf-8')
        req = urllib.request.Request(f"{WORKER_URL}/api/queue/{job_id}/status", data=json_data, method='POST')
        req.add_header('Content-Type', 'application/json')
        req.add_header('User-Agent', 'Mozilla/5.0')
        with urllib.request.urlopen(req, timeout=10) as response:
            print(f"[{job_id}] Status atualizado para: {status}")
    except Exception as e:
        print(f"Erro ao atualizar status do ID {job_id}: {e}")

def upload_to_r2(job_id, filepath):
    try:
        ext = filepath.split(".")[-1]
        print(f"Fazendo upload de {filepath} para o R2 via Worker...")
        with open(filepath, 'rb') as f:
            req = urllib.request.Request(f"{WORKER_URL}/api/queue/{job_id}/upload?ext={ext}", data=f, method='PUT')
            req.add_header('Content-Type', 'application/octet-stream')
            req.add_header('User-Agent', 'Mozilla/5.0')
            with urllib.request.urlopen(req, timeout=300) as response:
                if response.getcode() == 200:
                    return True
                else:
                    raise Exception(f"Erro no upload. Status: {response.getcode()}")
    except Exception as e:
        print(f"Erro no upload_to_r2: {e}")
        return False

def process_job(job):
    job_id = job['job_id']
    youtube_id = job['youtube_id']
    start_ms = job.get('start_ms', 0)
    end_ms = job.get('end_ms', 0)
    
    print(f"\n--- Iniciando Job {job_id} ---")
    
    try:
        if start_ms == -1 and end_ms == -1:
            update_job_status(job_id, "processando")
            subs = fetch_subtitles_info(youtube_id)
            import json
            update_job_status(job_id, "concluido", error_msg=json.dumps(subs))
            print(f"Info Job {job_id} finalizado.")
            return

        # 1. Download Modularizado
        update_job_status(job_id, "baixando")
        subtitle_lang = job.get('subtitle_lang')
        base_file, title, subtitle_path = download_youtube_video(youtube_id, DOWNLOAD_DIR, subtitle_lang=subtitle_lang)
        
        # 2. Edição Modularizada
        update_job_status(job_id, "cortando")
        output_file = os.path.join(DOWNLOAD_DIR, f"{job_id}.mp4")
        cut_video(base_file, output_file, start_ms, end_ms, subtitle_path=subtitle_path)
        
        # 3. Upload Modularizado
        update_job_status(job_id, "uploading")
        success = upload_to_r2(job_id, output_file)
        
        if not success:
            raise Exception("Falha no upload para o R2.")

        # Conclusão
        update_job_status(job_id, "concluido", title=title)
        print(f"Job {job_id} Finalizado com sucesso!")
        
    except Exception as e:
        error_msg = str(e)
        traceback.print_exc()
        print(f"Falha no Job {job_id}: {error_msg}")
        update_job_status(job_id, "erro", error_msg=error_msg)

def on_message(ws, message):
    try:
        data = json.loads(message)
        if data.get('type') == 'new_job':
            import threading
            threading.Thread(target=process_job, args=(data,)).start()
    except Exception as e:
        print(f"Erro ao processar mensagem do WS: {e}")

def on_error(ws, error):
    print(f"WebSocket Erro: {error}")

def on_close(ws, close_status_code, close_msg):
    print("WebSocket Fechado.")

def check_pending_jobs():
    try:
        req = urllib.request.Request(f"{WORKER_URL}/api/queue/next", method='GET')
        req.add_header('User-Agent', 'Mozilla/5.0')
        with urllib.request.urlopen(req, timeout=5) as response:
            if response.getcode() == 200:
                data = json.loads(response.read().decode('utf-8'))
                if data and 'job_id' in data:
                    print(f"Encontrado job pendente na fila ao conectar: {data['job_id']}")
                    import threading
                    threading.Thread(target=process_job, args=(data,)).start()
    except Exception as e:
        pass

def on_open(ws):
    print(f"Conectado ao WebSocket Orquestrador ({WORKER_URL.replace('http', 'ws')}/api/ws)!")
    import threading
    threading.Thread(target=check_pending_jobs).start()

def main():
    print("Iniciando Operador Orquestrador Modular com WebSockets...")
    ws_url = WORKER_URL.replace("https", "wss").replace("http", "ws") + "/api/ws"
    import websocket
    while True:
        try:
            ws = websocket.WebSocketApp(ws_url,
                                      header={"User-Agent": "Mozilla/5.0"},
                                      on_open=on_open,
                                      on_message=on_message,
                                      on_error=on_error,
                                      on_close=on_close)
            ws.run_forever()
        except Exception as e:
            print(f"Erro fatal: {e}")
        
        print("Reconectando em 5 segundos...")
        time.sleep(5)

if __name__ == "__main__":
    main()
