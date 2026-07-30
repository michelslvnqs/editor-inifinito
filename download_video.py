import os
import yt_dlp

def download_youtube_video(youtube_id, output_dir="downloads"):
    """
    Baixa um vídeo do YouTube em até 360p pre-muxed (vídeo + áudio juntos).
    Retorna o caminho absoluto do arquivo baixado e o título.
    """
    os.makedirs(output_dir, exist_ok=True)
    url = f"https://www.youtube.com/watch?v={youtube_id}"
    
    # Verifica se já existe um cache local com o ID
    for f in os.listdir(output_dir):
        if f.startswith(youtube_id + ".") and not f.startswith(youtube_id + "_"):
            # Para extrair título rapidamente do cache
            with yt_dlp.YoutubeDL({'quiet': True}) as ydl:
                info = ydl.extract_info(url, download=False)
                title = info.get('title', youtube_id)
            print(f"[{youtube_id}] Arquivo base encontrado no cache local.")
            return os.path.join(output_dir, f), title
            
    print(f"[{youtube_id}] Baixando arquivo base completo...")
    output_template = os.path.join(output_dir, f"{youtube_id}.%(ext)s")
    ydl_opts = {
        'format': 'best[height<=360]',
        'outtmpl': output_template,
        'quiet': True,
        'no_warnings': True,
    }
    
    title = youtube_id
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        title = info.get('title', youtube_id)
        
    for f in os.listdir(output_dir):
        if f.startswith(youtube_id + ".") and not f.startswith(youtube_id + "_"):
            return os.path.join(output_dir, f), title
            
    raise Exception(f"Falha ao localizar o arquivo baixado para {youtube_id}")
