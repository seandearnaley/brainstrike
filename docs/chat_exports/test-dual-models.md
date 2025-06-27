# Testing Dual Model Support

## Summary of Changes

### New Features Added:
1. **Model Selection Dropdown** - Choose between all-MiniLM-L6-v2 and BGE-M3
2. **Dynamic Model Information** - UI updates based on selected model
3. **Model Switching Protection** - Must dispose before switching models
4. **Enhanced Logging** - Shows which model is being initialized

### Model Configurations:

#### all-MiniLM-L6-v2 (Default)
- **Model ID**: `Xenova/all-MiniLM-L6-v2`
- **Size**: ~23MB
- **Dimensions**: 384
- **Languages**: English optimized
- **Features**: Fast, efficient, good for general semantic similarity

#### BGE-M3 (New)
- **Model ID**: `Xenova/bge-m3`
- **Size**: ~550MB  
- **Dimensions**: 1024
- **Languages**: Multilingual (100+ languages)
- **Features**: Dense + sparse + ColBERT embeddings, top-tier quality

## Testing Steps

### 1. Test Model Selection (Default State)
1. **Open browser at http://localhost:8083**
2. **Navigate to Embeddings tab** in right panel
3. **Verify dropdown shows** "all-MiniLM-L6-v2" selected by default
4. **Check model info displays**: 384D dimensions, ~23MB size

### 2. Test Small Model Initialization
1. **Click "Initialize Model"** (with all-MiniLM-L6-v2 selected)
2. **Watch console logs**:
   ```
   [EmbeddingsPanel] Starting initialization with model: all-MiniLM-L6-v2
   Creating feature extraction pipeline for Xenova/all-MiniLM-L6-v2...
   Feature extraction pipeline ready for Xenova/all-MiniLM-L6-v2!
   ```
3. **Verify UI updates** to show text input fields
4. **Test similarity calculation** with sample texts

### 3. Test Model Switching Protection
1. **Try to change dropdown** while model is loaded
2. **Should see error message**: "Please dispose the current model before switching"
3. **Dropdown change should be blocked**

### 4. Test Model Disposal and Switching
1. **Click "Dispose Model"**
2. **Verify UI returns** to initial state with dropdown enabled
3. **Change dropdown to "BGE-M3"**
4. **Check model info updates**: 1024D dimensions, ~550MB size
5. **Verify features list** shows multilingual and dense/sparse/ColBERT

### 5. Test BGE-M3 Model Initialization
1. **Click "Initialize Model"** (with BGE-M3 selected)
2. **Watch console logs**:
   ```
   [EmbeddingsPanel] Starting initialization with model: bge-m3
   Creating feature extraction pipeline for Xenova/bge-m3...
   Feature extraction pipeline ready for Xenova/bge-m3!
   ```
3. **Note longer download time** (~550MB vs ~23MB)
4. **Verify UI updates** to show text input fields
5. **Test similarity calculation** with sample texts

### 6. Test Memory Management
1. **Monitor browser memory usage** during BGE-M3 download
2. **Verify model disposal** clears memory properly
3. **Test switching between models** multiple times

## Expected Console Output

### Small Model (all-MiniLM-L6-v2):
```
[EmbeddingsPanel] Starting initialization with model: all-MiniLM-L6-v2
[EmbeddingsPanel] Progress: {stage: 'downloading', progress: 0, message: 'Loading transformers.js...'}
Creating feature extraction pipeline for Xenova/all-MiniLM-L6-v2...
[EmbeddingsPanel] Progress: {stage: 'downloading', progress: 25, message: 'Creating feature extraction pipeline...'}
Feature extraction pipeline ready for Xenova/all-MiniLM-L6-v2!
[EmbeddingsPanel] Initialization complete, status set to ready
```

### Large Model (BGE-M3):
```
[EmbeddingsPanel] Starting initialization with model: bge-m3
[EmbeddingsPanel] Progress: {stage: 'downloading', progress: 0, message: 'Loading transformers.js...'}
Creating feature extraction pipeline for Xenova/bge-m3...
[EmbeddingsPanel] Progress: {stage: 'downloading', progress: 25, message: 'Creating feature extraction pipeline...'}
[EmbeddingsPanel] Progress: {stage: 'downloading', progress: 45, message: 'Downloading pytorch_model.onnx... 67%'}
Feature extraction pipeline ready for Xenova/bge-m3!
[EmbeddingsPanel] Initialization complete, status set to ready
```

## Performance Expectations

### all-MiniLM-L6-v2:
- **Download**: 2-5 seconds
- **Initialization**: < 1 second  
- **Embedding Generation**: ~50ms per text
- **Memory Usage**: ~100MB

### BGE-M3:
- **Download**: 30-60 seconds (depending on connection)
- **Initialization**: 2-5 seconds
- **Embedding Generation**: ~200ms per text  
- **Memory Usage**: ~700MB

## Success Criteria ✅
- [ ] Model dropdown works correctly
- [ ] Both models initialize successfully
- [ ] Model info updates dynamically
- [ ] Model switching protection works
- [ ] Memory disposal works properly
- [ ] Similarity calculation works with both models
- [ ] BGE-M3 provides higher quality embeddings (should be noticeable with diverse/multilingual texts)

## Troubleshooting

If BGE-M3 fails to load:
1. **Check console for CORS errors** - should be handled by Vite proxy
2. **Verify WebGPU support** - will fallback to WASM automatically
3. **Monitor memory usage** - 16GB+ RAM recommended for BGE-M3
4. **Check network connection** - large model download

If models get stuck:
1. **Refresh the page** to reset everything
2. **Check browser developer tools** for errors
3. **Clear browser cache** if models seem corrupted