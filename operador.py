import time
import requests
import os
import subprocess
import traceback
import yt_dlp

# Mude para a URL do seu worker recém deployado
WORKER_URL = "https://blue-unit-2872.michelslvnqs.workers.dev"
# Exemplo: WORKER_URL = "https://blue-unit-2872.michelslvnqs.workers.dev"

DOWNLOAD_DIR = "downloads"
if not os.path.exists(DOWNLOAD_DIR):
    os.makedirs(DOWNLOAD_DIR)

def get_next_job():
    try:
        res = requests.get(f"{WORKER_URL}/api/queue/next", timeout=10)
        if res.status_code == 200:
            return res.json()
    except Exception as e:
        print(f"Erro ao buscar fila: {e}")
    return None

def update_job_status(youtube_id, status, title=None, error_msg=None):
    try:
        data = {"status": status, "title": title, "error_msg": error_msg}
        res = requests.post(f"{WORKER_URL}/api/queue/{youtube_id}/complete", json=data, timeout=10)
        print(f"[{youtube_id}] Status atualizado para {status}: {res.status_code}")
    except Exception as e:
        print(f"Erro ao atualizar status do ID {youtube_id}: {e}")

def upload_to_r2(youtube_id, filepath):
    try:
        ext = filepath.split(".")[-1]
        print(f"Fazendo upload de {filepath} para o R2 via Worker...")
        with open(filepath, 'rb') as f:
            res = requests.put(f"{WORKER_URL}/api/queue/{youtube_id}/upload?ext={ext}", data=f, timeout=300)
            if res.status_code == 200:
                return True
            else:
                raise Exception(f"Erro no upload. Status: {res.status_code}, Msg: {res.text}")
    except Exception as e:
        print(f"Erro no upload_to_r2: {e}")
        return False

def process_job(job):
    youtube_id = job['youtube_id']
    url = f"https://www.youtube.com/watch?v={youtube_id}"
    print(f"\n--- Iniciando Job {youtube_id} ---")
    print(f"URL: {url}")

    try:
        output_template = os.path.join(DOWNLOAD_DIR, f"{youtube_id}.%(ext)s")
        ydl_opts = {
            'format': 'best',
            'outtmpl': output_template,
            'quiet': True,
            'no_warnings': True,
        }
        
        print("Baixando...")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get('title', youtube_id)
        
        # Encontra o arquivo baixado
        downloaded_file = None
        for f in os.listdir(DOWNLOAD_DIR):
            if f.startswith(youtube_id):
                downloaded_file = os.path.join(DOWNLOAD_DIR, f)
                break
        
        if not downloaded_file:
            raise Exception("Arquivo baixado não encontrado localmente.")
        
        # Fazer upload para o R2
        success = upload_to_r2(youtube_id, downloaded_file)
        
        if not success:
            raise Exception("Falha no upload para o R2.")

        # Marca como concluído
        update_job_status(youtube_id, "concluido", title=title)
        print(f"Job {youtube_id} Finalizado com sucesso! Título: {title}")
        
    except Exception as e:
        error_msg = str(e)
        traceback.print_exc()
        print(f"Falha no Job {youtube_id}: {error_msg}")
        update_job_status(youtube_id, "erro", error_msg=error_msg)

def main():
    if WORKER_URL == "SUA_URL_DO_WORKER_AQUI":
        print("ERRO: Configure a constante WORKER_URL no início do script operador.py!")
        return

    print("Iniciando Operador...")
    print(f"Monitorando a API: {WORKER_URL}")
    while True:
        job = get_next_job()
        if job and 'youtube_id' in job:
            process_job(job)
        else:
            # print("Nenhum pedido na fila. Aguardando...")
            pass
            
        time.sleep(5)

if __name__ == "__main__":
    main()
