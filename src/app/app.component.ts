// src/app/app.component.ts - FIRST APP (CAPTURE APP)
import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IdCardDetectorService, Detection } from './services/id-card-detector.service';
import { DatabaseService } from './services/database.service';
import { Router } from '@angular/router';
import { HttpClient, HttpClientModule } from '@angular/common/http';

// Define API service URL - update this with your actual API endpoint
const API_URL = 'http://localhost:8001/api/idcards/';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
  standalone: true,
  imports: [CommonModule,HttpClientModule]
})
export class AppComponent implements OnInit, OnDestroy {
  @ViewChild('videoElement', { static: true }) videoElement!: ElementRef<HTMLVideoElement>;
  @ViewChild('canvasElement', { static: true }) canvasElement!: ElementRef<HTMLCanvasElement>;
  @ViewChild('shutterSound', { static: false }) shutterSound?: ElementRef<HTMLAudioElement>;

  title = 'ID card detection and Liveness verification';
  isModelLoaded = false;
  isStreaming = false;
  detections: Detection[] = [];
  inferenceTime = 0;
  stream: MediaStream | null = null;
  animationFrameId: number | null = null;
  modelPath = 'assets/best.onnx';
  errorMessage = '';
  
  // Document verification properties
  countries: string[] = ['Sri Lanka', 'India', 'United States', 'United Kingdom', 'Australia'];
  selectedCountry: string = 'Sri Lanka';
  documentTypes: string[] = ['ID Card', 'Driving License'];
  selectedDocType: string = 'ID Card';

  // Auto-capture related properties
  highConfidenceStartTime: number = 0;
  highConfidenceTimer: number = 0;
  confidenceThreshold: number = 0.97;
  capturedImage: string | null = null;
  lastFrameTime: number = 0;
  
  // Image quality properties
  originalCapturedImage: string | null = null;
  cropMargin = 20;
  flashActive: boolean = false;
  captureTimeout: any = null;
  capturingImage: boolean = false;
  
  // Processing status properties
  processingImage: boolean = false;
  storedImageId: string | null = null;
  apiStoredId: string | null = null;

  constructor(
    private idCardDetector: IdCardDetectorService,
    private databaseService: DatabaseService,
    private router: Router,
    private http: HttpClient
  ) {}

  async ngOnInit(): Promise<void> {
    try {
      // Test if the model file is accessible
      console.log('Testing model access at:', this.modelPath);
      
      try {
        const response = await fetch(this.modelPath);
        if (response.ok) {
          console.log('Model file found! Status:', response.status);
          const arrayBuffer = await response.arrayBuffer();
          console.log('Model size:', arrayBuffer.byteLength, 'bytes');
          
          // Initialize with the fetched model data
          await this.idCardDetector.initialize(arrayBuffer);
          this.isModelLoaded = true;
        } else {
          console.error('Model file not found. Status:', response.status, response.statusText);
          this.errorMessage = `Model file not found: ${response.status} ${response.statusText}`;
        }
      } catch (error) {
        console.error('Error fetching model file:', error);
        this.errorMessage = 'Error fetching model file. Check console for details.';
      }
    } catch (error) {
      console.error('Failed to initialize model:', error);
      this.errorMessage = 'Failed to load ONNX model. Please check console for details.';
    }
  }

  ngOnDestroy(): void {
    this.stopCamera();
    this.clearCaptureTimeout();
  }

  private clearCaptureTimeout(): void {
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
      this.captureTimeout = null;
    }
  }

  async startCamera(): Promise<void> {
    if (!this.isModelLoaded) {
      this.errorMessage = 'Model not loaded yet. Please wait or check for errors.';
      return;
    }

    console.log(`Starting detection for ${this.selectedDocType} from ${this.selectedCountry}`);

    try {
      // Reset flags first to avoid race conditions
      this.isStreaming = false;
      this.capturingImage = false;
      this.errorMessage = '';
      
      console.log('Requesting camera access...');
      
      // Request camera with more flexible constraints
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280, min: 640 },
          height: { ideal: 720, min: 480 }
        }
      });
      
      console.log('Camera access granted!');
      
      // Set video source
      this.videoElement.nativeElement.srcObject = this.stream;
      this.isStreaming = true;
      
      // Reset auto-capture related properties
      this.highConfidenceStartTime = 0;
      this.highConfidenceTimer = 0;
      this.capturedImage = null;
      this.originalCapturedImage = null;
      this.flashActive = false;
      
      // Wait for video to be ready
      this.videoElement.nativeElement.onloadedmetadata = () => {
        console.log(`Camera initialized with resolution: ${this.videoElement.nativeElement.videoWidth}x${this.videoElement.nativeElement.videoHeight}`);
        this.resizeCanvas();
        this.startDetection();
      };
    } catch (error: any) {
      console.error('Error accessing camera:', error);
      if (error.name === 'NotAllowedError') {
        this.errorMessage = 'Camera access denied. Please allow camera permissions in your browser.';
      } else if (error.name === 'NotFoundError') {
        this.errorMessage = 'No camera found. Please connect a camera and try again.';
      } else if (error.name === 'NotReadableError') {
        this.errorMessage = 'Camera is in use by another application. Please close other applications and try again.';
      } else if (error.name === 'OverconstrainedError') {
        // Try again with simpler constraints
        try {
          console.log('Trying with basic constraints...');
          this.stream = await navigator.mediaDevices.getUserMedia({ video: true });
          
          this.videoElement.nativeElement.srcObject = this.stream;
          this.isStreaming = true;
          
          // Reset properties here too
          this.highConfidenceStartTime = 0;
          this.highConfidenceTimer = 0;
          this.capturedImage = null;
          this.originalCapturedImage = null;
          this.flashActive = false;
          this.capturingImage = false;
          
          this.videoElement.nativeElement.onloadedmetadata = () => {
            this.resizeCanvas();
            this.startDetection();
          };
          return;
        } catch (fallbackError) {
          console.error('Fallback camera access also failed:', fallbackError);
          this.errorMessage = 'Could not access camera with basic settings. Please check your camera.';
        }
      } else {
        this.errorMessage = `Failed to access camera: ${error.name || 'Unknown error'}. Please ensure camera permissions are granted.`;
      }
    }
  }

  stopCamera(): void {
    this.clearCaptureTimeout();
    
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    
    this.isStreaming = false;
    this.detections = [];
    this.inferenceTime = 0;
    this.flashActive = false;
  }

  private resizeCanvas(): void {
    const video = this.videoElement.nativeElement;
    const canvas = this.canvasElement.nativeElement;
    
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    console.log(`Canvas resized to ${canvas.width}x${canvas.height}`);
  }

  private startDetection(): void {
    this.lastFrameTime = performance.now();
    
    const detectFrame = async (currentTime: number) => {
      if (!this.isStreaming) return;
      
      // Only skip processing, but continue the loop if capturing
      if (this.capturingImage) {
        this.animationFrameId = requestAnimationFrame(detectFrame);
        return;
      }
      
      // Calculate deltaTime for accurate timing
      const deltaTime = (currentTime - this.lastFrameTime) / 1000; // in seconds
      this.lastFrameTime = currentTime;
      
      const video = this.videoElement.nativeElement;
      const canvas = this.canvasElement.nativeElement;
      const ctx = canvas.getContext('2d');
      
      if (!ctx) return;
      
      try {
        // Draw video frame to canvas
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        // Get image data for detection
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        
        // Run detection
        const result = await this.idCardDetector.detect(imageData);
        this.detections = result.detections;
        this.inferenceTime = result.inferenceTime;
        
        // Draw detections
        this.drawDetections(ctx);
        
        // Check for high confidence detections
        const highConfidenceDetection = this.detections.find(
          det => det.confidence >= this.confidenceThreshold
        );
        
        if (highConfidenceDetection) {
          // If we have a high confidence detection
          if (this.highConfidenceStartTime === 0) {
            // Start the timer if it's not already started
            this.highConfidenceStartTime = currentTime;
          } else {
            // Update the timer
            this.highConfidenceTimer = (currentTime - this.highConfidenceStartTime) / 1000;
            
            // Check if we've had high confidence for long enough (0.5 seconds)
            if (this.highConfidenceTimer >= 0.5) {
              this.capturingImage = true;
              this.captureHighQualityImage(canvas, highConfidenceDetection.box);
              return; // Stop the detection loop
            }
          }
        } else {
          // Reset the timer if confidence drops
          this.highConfidenceStartTime = 0;
          this.highConfidenceTimer = 0;
        }
      } catch (error) {
        console.error('Detection error:', error);
      }
      
      // Request next frame
      this.animationFrameId = requestAnimationFrame(detectFrame);
    };
    
    // Start detection loop
    this.animationFrameId = requestAnimationFrame(detectFrame);
  }

  private drawDetections(ctx: CanvasRenderingContext2D): void {
    const canvas = this.canvasElement.nativeElement;
    
    // Clear previous drawings (we already have the video frame drawn)
    ctx.font = '16px Arial';
    
    // Draw each detection
    for (const det of this.detections) {
      const [x1, y1, x2, y2] = det.box;
      const confidence = det.confidence;
      const label = `${det.class_name}: ${(confidence * 100).toFixed(1)}%`;
      
      // Draw bounding box with different color for high confidence
      ctx.strokeStyle = confidence >= this.confidenceThreshold ? 'rgb(255, 215, 0)' : 'rgb(0, 255, 0)';
      ctx.lineWidth = 3;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      
      // Draw label background
      const textMeasure = ctx.measureText(label);
      const textHeight = 20;
      ctx.fillStyle = confidence >= this.confidenceThreshold ? 'rgb(255, 215, 0)' : 'rgb(0, 255, 0)';
      ctx.fillRect(x1, y1 - textHeight, textMeasure.width + 10, textHeight);
      
      // Draw label text
      ctx.fillStyle = 'rgb(0, 0, 0)';
      ctx.fillText(label, x1 + 5, y1 - 5);
    }
    
    // Draw inference time
    ctx.fillStyle = 'rgb(255, 0, 0)';
    ctx.font = '20px Arial';
    ctx.fillText(`Inference time: ${this.inferenceTime.toFixed(1)} ms`, 10, 30);
    
    // Draw auto-capture timer if active
    if (this.highConfidenceTimer > 0) {
      ctx.fillStyle = 'rgb(255, 215, 0)';
      ctx.font = '20px Arial';
      ctx.fillText(`Auto-capture in: ${(0.5 - this.highConfidenceTimer).toFixed(1)}s`, 10, 60);
    }
  }
  
  private captureHighQualityImage(canvas: HTMLCanvasElement, box: number[]): void {
    // Clear any existing timeout
    this.clearCaptureTimeout();
    
    console.log('Preparing to capture high quality image...');
    
    // 1. Activate flash
    this.flashActive = true;
    
    // 2. Try to focus the video element
    if (this.videoElement && this.videoElement.nativeElement) {
      try {
        // Call focus if available
        if (typeof this.videoElement.nativeElement.focus === 'function') {
          this.videoElement.nativeElement.focus();
        }
      } catch (err) {
        console.warn('Could not focus video element:', err);
      }
    }
    
    // 3. Wait a moment for the camera to stabilize and adjust
    this.captureTimeout = setTimeout(() => {
      try {
        // Play camera shutter sound if available
        if (this.shutterSound && this.shutterSound.nativeElement) {
          this.shutterSound.nativeElement.play().catch(err => {
            console.warn('Could not play shutter sound:', err);
          });
        }
        
        // Get the latest video frame
        const video = this.videoElement.nativeElement;
        const ctx = canvas.getContext('2d');
        
        if (ctx) {
          // Redraw the video to canvas to get the latest frame
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          
          // Store full image at maximum quality
          this.originalCapturedImage = canvas.toDataURL('image/png', 1.0);
          
          // Now crop to the card area
          this.capturedImage = this.cropImage(canvas, box);
          
          console.log('High quality ID card image captured!');
        }
      } catch (error) {
        console.error('Error capturing high quality image:', error);
      } finally {
        // Turn off flash and clean up
        this.flashActive = false;
        this.capturingImage = false;
        this.stopCamera();
      }
    }, 500); // 500ms delay to stabilize
  }
  
  /**
   * Crop the image to focus on the ID card with high quality
   */
  private cropImage(canvas: HTMLCanvasElement, box: number[]): string {
    const [x1, y1, x2, y2] = box;
    let width = x2 - x1;
    let height = y2 - y1;
    
    // Add margin to the cropped area
    const x = Math.max(0, x1 - this.cropMargin);
    const y = Math.max(0, y1 - this.cropMargin);
    width = Math.min(canvas.width - x, width + this.cropMargin * 2);
    height = Math.min(canvas.height - y, height + this.cropMargin * 2);
    
    // Create a temporary canvas for the cropped image
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) return '';
    
    // Apply a slight sharpening filter to enhance details
    tempCtx.filter = 'contrast(1.1) saturate(1.1)';
    
    // Draw the cropped part to the temporary canvas
    tempCtx.drawImage(
      canvas, 
      x, y, width, height,  // Source rectangle
      0, 0, width, height   // Destination rectangle
    );
    
    // Reset filter
    tempCtx.filter = 'none';
    
    // Get the image data as PNG (lossless) for maximum quality
    return tempCanvas.toDataURL('image/png', 1.0);
  }

  manualCapture(): void {
    if (!this.isStreaming || this.capturingImage) return;
    
    const canvas = this.canvasElement.nativeElement;
    
    // Find high confidence detection if available
    const highConfidenceDetection = this.detections.find(
      det => det.confidence >= this.confidenceThreshold
    );
    
    if (highConfidenceDetection) {
      this.capturingImage = true;
      this.captureHighQualityImage(canvas, highConfidenceDetection.box);
    } else if (this.detections.length > 0) {
      // Use the highest confidence detection available
      const bestDetection = [...this.detections].sort((a, b) => b.confidence - a.confidence)[0];
      this.capturingImage = true;
      this.captureHighQualityImage(canvas, bestDetection.box);
    } else {
      alert('No ID card detected. Please position your ID card within view.');
    }
  }

  retakePhoto(): void {
    this.capturedImage = null;
    this.originalCapturedImage = null;
    this.storedImageId = null;
    this.apiStoredId = null;
    this.startCamera();
  }
  
  /**
   * Process the captured image, store it locally and in the backend API,
   * then redirect to the second app with the ID as a parameter
   */
  async proceedWithImage(): Promise<void> {
    if (!this.capturedImage) {
      this.errorMessage = 'No image captured. Please try again.';
      return;
    }
    
    try {
      this.processingImage = true;
      console.log('Proceeding with the captured image...');
      console.log(`Document type: ${this.selectedDocType}, Country: ${this.selectedCountry}`);
      
      // 1. Store data in local IndexedDB (for this app's use)
      this.storedImageId = await this.databaseService.storeIdCardData(
        this.capturedImage,
        this.selectedCountry,
        this.selectedDocType
      );
      
      console.log('Image stored locally with ID:', this.storedImageId);
      
      // 2. Send data to backend API for cross-app sharing
      const apiRequest = {
        image: this.capturedImage,
        country: this.selectedCountry,
        documentType: this.selectedDocType
      };
      
      // Using HttpClient for better error handling
      const apiResponse = await this.http.post<{id: string, timestamp: number}>(
        API_URL, 
        apiRequest
      ).toPromise();
      
      if (!apiResponse || !apiResponse.id) {
        throw new Error('Invalid API response');
      }
      
      // Store the API ID
      this.apiStoredId = apiResponse.id;
      console.log('Image stored in backend API with ID:', this.apiStoredId);
      
      // 3. Check if the data is retrievable from the API
      const verifyResponse = await this.http.get(`${API_URL}${this.apiStoredId}`).toPromise();
      console.log('Verified data retrieval from API:', verifyResponse);
      
      // 4. Create redirect URL to second app
      const targetAppBaseUrl = 'http://localhost:3000'; // Update with your second app URL
      const redirectUrl = `${targetAppBaseUrl}?id=${this.apiStoredId}&docType=${encodeURIComponent(this.selectedDocType)}&country=${encodeURIComponent(this.selectedCountry)}`;
      
      // 5. Confirm and redirect
      // const confirmRedirect = confirm(
      //   `ID card captured and stored successfully!\n\nID: ${this.apiStoredId}\n\nYou will now be redirected to the verification app.`
      // );
      window.location.href = redirectUrl;
      // if (confirmRedirect) {
      //   console.log('Redirecting to:', redirectUrl);
      //   window.location.href = redirectUrl;
      // }
      
    } catch (error) {
      console.error('Error processing image:', error);
      this.errorMessage = 'Failed to process and store image data. Please try again.';
    } finally {
      this.processingImage = false;
    }
  }
  
  // For debugging - toggle between cropped and original image
  toggleImageView(): void {
    if (this.originalCapturedImage && this.capturedImage) {
      const temp = this.capturedImage;
      this.capturedImage = this.originalCapturedImage;
      this.originalCapturedImage = temp;
    }
  }
}