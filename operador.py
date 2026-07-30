import os
import time
import traceback
import subprocess
import sys
import shutil

# === AUTO-INSTALAÇÃO DE DEPENDÊNCIAS ===
def ensure_dependencies():
    missing_pkgs = []
    
    try:
        import yt_dlp
    except ImportError:
        missing_pkgs.append("yt-dlp")
        
    # FFMPEG (binário) - se não estiver no sistema, usaremos o imageio-ffmpeg que baixa um executável estático embutido
    if not shutil.which("ffmpeg"):
        try:
            import imageio_ffmpeg
        except ImportError:
            missing_pkgs.append("imageio-ffmpeg")
            
    if missing_pkgs:
        print(f"Buscando dependências ausentes: {', '.join(missing_pkgs)}...")
        subprocess.run([sys.executable, "-m", "pip", "install", *missing_pkgs], check=True)

ensure_dependencies()

import yt_dlp
import urllib.request
import json

def get_ffmpeg_path():
    if shutil.which("ffmpeg"):
        return "ffmpeg"
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()

FFMPEG_EXE = get_ffmpeg_path()
# ========================================

# Configurações

# Configurações
WORKER_URL = "https://blue-unit-2872.michelslvnqs.workers.dev"  # Substitua pela URL do seu Worker
DOWNLOAD_DIR = "downloads"

# Garante que a pasta de downloads existe
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

def get_next_job():
    try:
        req = urllib.request.Request(f"{WORKER_URL}/api/queue/next")
        with urllib.request.urlopen(req, timeout=10) as response:
            if response.getcode() == 200:
                return json.loads(response.read().decode())
    except Exception as e:
        print(f"Erro ao buscar fila: {e}")
    return None

def update_job_status(job_id, status, title=None, error_msg=None):
    try:
        data = {"status": status, "title": title, "error_msg": error_msg}
        json_data = json.dumps(data).encode('utf-8')
        req = urllib.request.Request(f"{WORKER_URL}/api/queue/{job_id}/complete", data=json_data, method='POST')
        req.add_header('Content-Type', 'application/json')
        with urllib.request.urlopen(req, timeout=10) as response:
            print(f"[{job_id}] Status atualizado para {status}: {response.getcode()}")
    except Exception as e:
        print(f"Erro ao atualizar status do ID {job_id}: {e}")

def upload_to_r2(job_id, filepath):
    try:
        ext = filepath.split(".")[-1]
        print(f"Fazendo upload de {filepath} para o R2 via Worker...")
        with open(filepath, 'rb') as f:
            req = urllib.request.Request(f"{WORKER_URL}/api/queue/{job_id}/upload?ext={ext}", data=f, method='PUT')
            req.add_header('Content-Type', 'application/octet-stream')
            with urllib.request.urlopen(req, timeout=300) as response:
                if response.getcode() == 200:
                    return True
                else:
                    raise Exception(f"Erro no upload. Status: {response.getcode()}, Msg: {response.read().decode()}")
    except Exception as e:
        print(f"Erro no upload_to_r2: {e}")
        return False

def process_job(job):
    job_id = job['job_id']
    youtube_id = job['youtube_id']
    start_ms = job.get('start_ms', 0)
    end_ms = job.get('end_ms', 0)
    
    url = f"https://www.youtube.com/watch?v={youtube_id}"
    print(f"\n--- Iniciando Job {job_id} ---")
    print(f"URL Base: {url} | Corte: {start_ms}ms até {end_ms}ms")

    try:
        # 1. Verifica se o vídeo base já existe localmente
        base_file = None
        title = youtube_id
        
        for f in os.listdir(DOWNLOAD_DIR):
            if f.startswith(youtube_id + ".") and not f.startswith(job_id):
                base_file = os.path.join(DOWNLOAD_DIR, f)
                break
        
        if not base_file:
            print("Vídeo base não encontrado localmente. Baixando arquivo completo...")
            output_template = os.path.join(DOWNLOAD_DIR, f"{youtube_id}.%(ext)s")
            ydl_opts = {
                'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
                'outtmpl': output_template,
                'quiet': True,
                'no_warnings': True,
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
                title = info.get('title', youtube_id)
            
            # Procurar novamente o arquivo base após download
            for f in os.listdir(DOWNLOAD_DIR):
                if f.startswith(youtube_id + ".") and not f.startswith(job_id):
                    base_file = os.path.join(DOWNLOAD_DIR, f)
                    break
        else:
            print("Vídeo base já existe no cache local! Pulando download longo.")
            # Para extrair o título rápido já que pulamos o download
            with yt_dlp.YoutubeDL({'quiet': True}) as ydl:
                info = ydl.extract_info(url, download=False)
                title = info.get('title', youtube_id)

        if not base_file:
            raise Exception("Falha ao localizar o vídeo base após o download.")
        
        # 2. Processa o corte com FFMPEG
        output_file = os.path.join(DOWNLOAD_DIR, f"{job_id}.mp4")
        start_s = start_ms / 1000.0
        end_s = end_ms / 1000.0
        
        print(f"Cortando vídeo com FFmpeg (de {start_s}s até {end_s}s)...")
        # -y: sobrescreve se existir
        # -ss e -to: início e fim
        # -c:v libx264 -crf 18 -preset fast: reencode leve para garantir precisão e qualidade máxima
        # -c:a aac: converte áudio para aac (padrão)
        ffmpeg_cmd = [
            FFMPEG_EXE, "-y",
            "-i", base_file,
            "-ss", str(start_s),
            "-to", str(end_s),
            "-c:v", "libx264",
            "-crf", "18",
            "-preset", "fast",
            "-c:a", "aac",
            output_file
        ]
        
        subprocess.run(ffmpeg_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        if not os.path.exists(output_file):
            raise Exception("FFMPEG falhou ao gerar o arquivo de saída.")

        # 3. Fazer upload para o R2 do arquivo CORTADO
        success = upload_to_r2(job_id, output_file)
        
        if not success:
            raise Exception("Falha no upload para o R2.")

        # Marca como concluído
        update_job_status(job_id, "concluido", title=title)
        print(f"Job {job_id} Finalizado com sucesso! Título Base: {title}")
        
    except Exception as e:
        error_msg = str(e)
        traceback.print_exc()
        print(f"Falha no Job {job_id}: {error_msg}")
        update_job_status(job_id, "erro", error_msg=error_msg)

def main():
    print("Iniciando Operador de Cortes e Edição...")
    print(f"Monitorando a API: {WORKER_URL}")
    while True:
        job = get_next_job()
        if job and 'job_id' in job:
            process_job(job)
        else:
            time.sleep(5)

if __name__ == "__main__":
    main()
