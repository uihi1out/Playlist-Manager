import requests

try:
    resp = requests.get('https://www.youtube.com/playlist?list=RDMM')
    print("YT Request succeeded")
except Exception as e:
    print(f"YT Request Failed: {e}")
