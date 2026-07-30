import os
import subprocess
import shutil

def get_ffmpeg_path():
    if shutil.which("ffmpeg"):
        return "ffmpeg"
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return "ffmpeg"

FFMPEG_EXE = get_ffmpeg_path()

def cut_video(input_path, output_path, start_ms, end_ms):
    """
    Recebe um vídeo de entrada e corta no intervalo especificado.
    Retorna o caminho do arquivo de saída.
    """
    start_s = start_ms / 1000.0
    end_s = end_ms / 1000.0
    
    print(f"Cortando vídeo de {start_s}s até {end_s}s...")
    
    ffmpeg_cmd = [
        FFMPEG_EXE, "-y",
        "-i", input_path,
        "-ss", str(start_s),
        "-to", str(end_s),
        "-c:v", "libx264",
        "-crf", "18",
        "-preset", "fast",
        "-c:a", "aac",
        output_path
    ]
    
    subprocess.run(ffmpeg_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    if not os.path.exists(output_path):
        raise Exception("FFMPEG falhou ao gerar o arquivo de saída.")
        
    return output_path
