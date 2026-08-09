import urllib.parse
import urllib.request

data = urllib.parse.urlencode({"email": "demo@example.com"}).encode()
req = urllib.request.Request("http://localhost:8000/api/check-email", data=data, method="POST")
with urllib.request.urlopen(req) as response:
    print(response.read().decode("utf-8"))
