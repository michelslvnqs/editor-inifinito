import subprocess
import sys

def install_yt_dlp():
    try:
        import yt_dlp
    except ImportError:
        print("yt-dlp não encontrado. Instalando automaticamente...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "yt-dlp"])
        print("Instalação concluída com sucesso!")

def download_video(url):
    import yt_dlp
    
    # Configurações para baixar até 720p na pasta atual do projeto
    # O formato 'best[height<=720]' procura um arquivo que já tenha vídeo e áudio juntos até 720p
    ydl_opts = {
        'format': 'best[height<=720]',
        'outtmpl': '%(title)s.%(ext)s',
    }
    
    print(f"\nIniciando o download de: {url}")
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        print("\nDownload finalizado com sucesso!")
    except Exception as e:
        print(f"\nOcorreu um erro durante o download: {e}")

if __name__ == "__main__":
    # Verifica e instala dependência
    install_yt_dlp()
    
    # Link fornecido
    video_url = "https://www.youtube.com/watch?v=bpOSxM0rNPM"
    
    # Inicia o download
    download_video(video_url)
