from fastapi import FastAPI, Request
from pydantic import BaseModel
import uvicorn

class PredictData(BaseModel):
    metrics: list

app = FastAPI()

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.post("/predict")
async def predict(data: PredictData):
    score = sum([len(str(m)) for m in data.metrics])
    return {"prediction": score}

@app.post("/recommend")
async def recommend(request: Request):
    body = await request.json()
    return {"recommendation": f"Analyze metrics: {body.get('metrics', [])}"}

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=5000, reload=True)
