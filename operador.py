import time
import requests
import os
import subprocess
import traceback

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

def update_job_status(uid, status, r2_url=None, error_msg=None):
    try:
        data = {"status": status, "r2_url": r2_url, "error_msg": error_msg}
        res = requests.post(f"{WORKER_URL}/api/queue/{uid}/complete", json=data, timeout=10)
        print(f"[{uid}] Status atualizado para {status}: {res.status_code}")
    except Exception as e:
        print(f"Erro ao atualizar status do UID {uid}: {e}")

def upload_to_r2(uid, filepath):
    try:
        ext = filepath.split(".")[-1]
        print(f"Fazendo upload de {filepath} para o R2 via Worker...")
        with open(filepath, 'rb') as f:
            # Enviamos o arquivo via PUT para a rota de upload do Worker
            res = requests.put(f"{WORKER_URL}/api/queue/{uid}/upload?ext={ext}", data=f, timeout=300)
            if res.status_code == 200:
                data = res.json()
                return data.get("download_url")
            else:
                raise Exception(f"Erro no upload. Status: {res.status_code}, Msg: {res.text}")
    except Exception as e:
        print(f"Erro no upload_to_r2: {e}")
        return None

def process_job(job):
    uid = job['uid']
    url = job['youtube_url']
    print(f"\n--- Iniciando Job {uid} ---")
    print(f"URL: {url}")

    try:
        # Aqui você insere sua lógica real de download.
        # Estamos simulando usando o yt-dlp via subprocess.
        output_template = os.path.join(DOWNLOAD_DIR, f"{uid}.%(ext)s")
        
        print("Baixando...")
        cmd = ["yt-dlp", "-f", "best", "-o", output_template, url]
        subprocess.run(cmd, check=True)
        
        # Encontra o arquivo baixado
        downloaded_file = None
        for f in os.listdir(DOWNLOAD_DIR):
            if f.startswith(uid):
                downloaded_file = os.path.join(DOWNLOAD_DIR, f)
                break
        
        if not downloaded_file:
            raise Exception("Arquivo baixado não encontrado localmente.")
        
        # Fazer upload para o R2 (passando pelo Worker)
        download_url = upload_to_r2(uid, downloaded_file)
        
        if not download_url:
            raise Exception("Falha no upload para o R2.")

        # Marca como concluído
        update_job_status(uid, "concluido", r2_url=download_url)
        print(f"Job {uid} Finalizado com sucesso!")
        
    except Exception as e:
        error_msg = str(e)
        traceback.print_exc()
        print(f"Falha no Job {uid}: {error_msg}")
        update_job_status(uid, "erro", error_msg=error_msg)

def main():
    if WORKER_URL == "SUA_URL_DO_WORKER_AQUI":
        print("ERRO: Configure a constante WORKER_URL no início do script operador.py!")
        return

    print("Iniciando Operador...")
    print(f"Monitorando a API: {WORKER_URL}")
    while True:
        job = get_next_job()
        if job and 'uid' in job:
            process_job(job)
        else:
            # print("Nenhum pedido na fila. Aguardando...")
            pass
            
        time.sleep(5)

if __name__ == "__main__":
    main()
