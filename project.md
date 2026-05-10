# GLM Ledger Frontend - Complete Master Plan

## Project Overview
```
GLM Ledger - India's Most Powerful Accounting Platform
Frontend: Next.js 15 + TypeScript + Tailwind + React Three Fiber
Backend: Express.js + PostgreSQL (already built)
Features: GST, e-Invoicing, Payroll, Inventory, Banking, TDS
```

---

## ✅ PHASE 1: FOUNDATION (COMPLETED)

### 1.1 Project Architecture
```
glm-ledger/
├── backend/           # Existing backend (port 3000)
│   ├── src/api/      # Express routes
│   ├── src/models/   # Database models
│   └── ...
├── frontend/          # New frontend (port 3001)
│   ├── src/app/      # Next.js App Router
│   ├── src/components/ # React components
│   ├── src/hooks/    # Custom hooks
│   ├── src/store/    # Zustand stores
│   ├── src/lib/      # Utilities
│   └── src/types/    # TypeScript types
```

### 1.2 Setup Steps (COMPLETED)
- [x] Initialize Next.js 15 with TypeScript
- [x] Install dependencies (Three.js, Framer Motion, Zustand, Recharts)
- [x] Configure Tailwind CSS with custom theme
- [x] Implement shadcn/ui components
- [x] Build API client (Axios + interceptors)
- [x] Create Zustand auth store
- [x] Setup JWT authentication
- [x] Build and test production build

### 1.3 Authentication (COMPLETED)
- [x] Login page (`/login`) - Glassmorphism design
- [x] Register page (`/register`) - Company creation
- [x] JWT token management
- [x] Auto-refresh on 401
- [x] Logout functionality
- [x] Protected routes middleware

---

## 🔲 PHASE 2: ENHANCED 3D LANDING PAGE

### 2.1 Hero Section 3D Background
**Current:** Static gradient with particles
**Target:** Full immersive 3D environment

### Implementation Details
```tsx
// Components to modify:
- src/components/3d/ImmersiveBackground.tsx
- src/components/3d/ImmersiveScene.tsx
- src/components/landing/HeroSection.tsx
- src/app/page.tsx
```

**3D Enhancements:**
```typescript
// ParticleField - 3000 particles with custom shader
// - Size: 3000 particles
// - Colors: Saffron (#FF6F00), Indigo (#1A237E), Gold (#FFD700)
// - Movement: Organic floating with noise
// - Interaction: Mouse repel effect
// - Shader: Custom GLSL with bloom

// FloatingRupee - 3D model
// - Geometry: Torus + cylinder extrusion
// - Material: MeshStandardMaterial with metalness 0.9
// - Animation: Slow rotation + float
// - Glow: Emissive material with bloom

// FloatingCoins - 20 coin objects
// - Geometry: Cylinder with rounded edges
// - Colors: Random saffron/indigo
// - Movement: Orbital path around center
// - Trail: Particle trail on movement

// Stars Background
// - Count: 5000 stars
// - Color: Warm white
// - Movement: Slow drift
// - Depth: 3 layers at different distances

// Fog Effect
// - Type: Exponential fog
// - Color: #0a0a1a (dark indigo)
// - Near: 10, Far: 100

// 3D Grid Floor
// - Style: Wireframe grid
// - Color: Amber 500/20% opacity
// - Movement: Animated grid lines
// - Perspective: Creates depth illusion
```

### 2.2 Hero Content
**Typography:**
- Title: "GLM Ledger" - text-[10vw] with gradient text
- Subtitle: "India's Most Powerful Accounting Engine" - text-3xl
- Description: "Built for Indian businesses..." - text-xl max-w-2xl
- Trust badges: 4 badges with animated icons

**Animations:**
- Title: Text scramble effect → clean text
- Subtitle: Fade in with delay 0.5s
- Description: Fade in with delay 0.8s
- Buttons: Slide up with delay 1s
- Background: 3D scene with mouse parallax

### 2.3 Scroll Animations
```typescript
// Using Framer Motion's useScroll
// Scroll-triggered parallax on 3D elements
// - Camera moves with scroll
// - Objects rotate
// - Depth effect increases

// GSAP ScrollTrigger for sections
// - Features: Staggered card animations
// - Trust: Counter animation
// - CTA: Scale up on enter
```

---

## 🔲 PHASE 3: FEATURES SECTION

### 3.1 Holographic 3D Cards
```typescript
// Card Component
interface HolographicCard {
  icon: LucideIcon;
  title: string;
  description: string;
  gradient: string; // amber-to-orange, indigo-to-purple
}

// 3D Hover Effects:
// - rotateX/Y on hover (perspective: 1000px)
// - translateZ on hover (pop forward)
// - Border glow on hover (amber-500/30)
// - Holographic sheen sweep (linear-gradient animation)
// - Icon scale + color change

// Implementation:
// - CSS transform-style: preserve-3d
// - Framer Motion whileHover={{ rotateX: 5, rotateY: 5 }}
// - CSS animation for holographic sweep
```

### 3.2 Features Section Layout
```typescript
// Grid: 3 columns desktop, 2 tablet, 1 mobile
// Each card has:
//   - Top: Icon in gradient circle
//   - Title: Large bold text
//   - Description: Short text
//   - Hover: 3D tilt + gradient sweep + icon scale
```

---

## 🔲 PHASE 4: TRUST SECTION

### 4.1 Animated Statistics
```typescript
// 4 stats with animated counters
// - Animated counter from 0 to value
// - Duration: 2 seconds
// - Format: Indian Rupee with commas
// - Easing: ease-out

// Stats:
// - 50,000+ Businesses
// - ₹12T+ Transactions
// - 2M+ Active Users
// - 99.9% Uptime
```

### 4.2 Trust Badges
```typescript
// 4 badges with animated icons
// - Shield: 256-bit Encrypted
// - FileCheck: GST Ready
// - Lock: RBI Compliant
// - TrendingUp: AI Powered
// Animations: Bounce, pulse on hover
```

---

## 🔲 PHASE 5: DASHBOARD

### 5.1 3D Sidebar
```typescript
// Active item:
// - Amber gradient background
// - Amber text
// - Left border accent
// - Glow shadow
// - Scale up slightly

// Hover effects:
// - translateX(4px) on hover
// - Background color change
// - Icon scale
// - Text color change
```

### 5.2 Dashboard Widgets
**KPI Cards:**
```
4 cards with:
- Icon (color-coded: green, red, amber, blue)
- Title (small text)
- Value (large number with ₹)
- Trend (green/red with arrow)
- Hover: Shadow + border glow
```

**Chart Area:**
```
Revenue vs Expenses:
- Area Chart with gradient fills
- Custom tooltip with dark theme
- Interactive hover data display
- 6 months data
```

**GST Widget:**
```
3 filing statuses:
- GSTR-1: Filed (green)
- GSTR-3B: Pending (amber)
- GSTR-9: Overdue (red)
- Action alerts
```

**Quick Actions:**
```
4 action buttons:
- Create Invoice (amber)
- Record Payment (green)
- Make Payment (red)
- View Reports (blue)
```

---

## 🔲 PHASE 6: POST-PROCESSING & EFFECTS

### 6.1 Bloom Effect
```typescript
// @react-three/postprocessing
// - Bloom intensity: 0.5
// - Luminance threshold: 0.1
// - Luminance smoothing: 0.1
// - Mipmap blur: true

// Applied to:
// - Floating coins (emissive)
// - Particle trail
// - Rupee symbol
// - Active menu items
```

### 6.2 Custom Shaders
```glsl
// Fragment shader for particles
// - Custom color mixing
// - Noise-based movement
// - Glow around emissive objects

// Vertex shader for particles
// - Size attenuation
// - Custom position math
// - Wave/ripple effects
```

---

## 🔲 PHASE 7: RESPONSIVE DESIGN

### 7.1 Desktop (1024px+)
```
- Full 3D background
- 3-column feature grid
- Side-by-side dashboard layout
```

### 7.2 Tablet (768px-1024px)
```
- Hidden background
- 2-column feature grid
- Stacked dashboard layout
```

### 7.3 Mobile (< 768px)
```
- Hidden background
- 1-column feature grid
- Single column everything
- Hamburger menu for sidebar
```

---

## 🔲 PHASE 8: PERFORMANCE OPTIMIZATION

### 8.1 Code Splitting
```typescript
// Lazy load 3D components
// - ImmersiveBackground.tsx (lazy)
// - Chart components (lazy)
// - Dashboard widgets (lazy)
```

### 8.2 Asset Optimization
```
- Compress 3D models
- Optimize image assets
- Use WebP format
- Implement next/image
```

### 8.3 Bundle Size
```
- Tree shake unused code
- Remove unused dependencies
- Use next-dynamic for heavy components
```

---

## 🔲 PHASE 9: BACKEND INTEGRATION

### 9.1 API Endpoints
```
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
GET  /api/v1/auth/me
POST /api/v1/vouchers/sales
GET  /api/v1/dashboard/stats
GET  /api/v1/gst/status
GET  /api/v1/reports/revenue
```

### 9.2 TanStack Query
```typescript
// Hooks:
// - useAuth() - Authentication
// - useDashboard() - Dashboard data
// - useGST() - GST status
// - useReports() - Financial reports
```

---

## 🔲 PHASE 10: DEPLOYMENT

### 10.1 Vercel Config
```json
{
  "version": 2,
  "builds": [
    {
      "src": "frontend/package.json",
      "use": "@vercel/next"
    }
  ]
}
```

### 10.2 Environment Variables
```
NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1
NEXT_PUBLIC_APP_NAME=GLM Ledger
NEXT_PUBLIC_APP_URL=http://localhost:3001
```

---

## ✅ CHECKLIST FOR NEW CHAT

### To re-initialize the project:
1. Run: `cd "C:\Users\aansh\OneDrive\Documents\glm 5.11\frontend"`
2. Run: `npm run dev`
3. Open browser to: `http://localhost:3000`

### To start specific work:
1. Read this file (`project.md`)
2. Check current progress
3. Start with incomplete phases
4. Build → Test → Deploy

---

## 📋 TECH STACK

### Frontend
- Next.js 16
- React 19
- TypeScript
- Tailwind CSS
- Framer Motion
- React Three Fiber
- @react-three/drei
- @react-three/postprocessing
- Zustand
- TanStack Query
- Axios
- Recharts
- Lucide React
- shadcn/ui

### 3D Assets
- Three.js (core)
- WebGL
- Custom GLSL shaders
- GLTF models (optional)

### Backend
- Express.js
- JWT authentication
- PostgreSQL
- TypeORM/Prisma

---

## 🎨 DESIGN TOKENS

### Colors
```css
--primary: #FF6F00 (Saffron)
--secondary: #1A237E (Indigo)
--accent: #FFD700 (Gold)
--background: #0a0a1a (Dark)
--text: #ffffff (White)
--muted: #94a3b8 (Slate)
```

### Typography
```
title: 6xl, extrabold gradient text-description: 3xl, gradient text
body: xl, normal weight
caption: sm, muted color
```

### Spacing
```
section: py-32 (128px)
container: max-w-7xl
card: p-8
```

---

## 🤝 AGENT INSTRUCTIONS

When starting a new chat:
1. Read `project.md`
2. Check `package.json` for dependencies
3. Verify `next.config.ts` configuration
4. Check current file structure
5. Start with highest priority incomplete item
6. Build incrementally
7. Test after each major change
8. Document changes in chat container html:
- Feature cards with 3D tilt + holographic sheen

### Trust Section
- 4 animated stats with counter animation
- Trust badges with bouncing icons

### CTA Section
- Gradient background with orb glow
- Large CTA buttons with shine effect
- Animated statistics

---

## 🔢 SIZING & SPACING

### Hero
```
min-h: 100vh
padding: py-20 (top/bottom)
center: flex items-center justify-center
```

### Features
```
section: py-32 (128px)
grid: 3 columns, gap-8 (32px)
card: p-8 (32px), rounded-3xl
```

### Trust
```
section: py-32 (128px)
grid: 4 columns, gap-8 (32px)
stats: text-4xl, font-bold
```

---

## 🎬 ANIMATION SPECS

### Hero
```
Title: Fade in + slide up (1.2s, delay 0.2s)
Description: Fade in + slide up (1s, delay 0.5s)
Buttons: Fade in + slide up (0.8s, delay 0.8s)
Badges: Fade in + slide up (0.8s, delay 1s)
Scroll indicator: Bounce animation (1.5s, infinite)
```

### Features
```
Heading: Fade in + slide up (0.6s, ease-out, scroll trigger)
Cards: Staggered fade in + slide up (0.5s each, 0.1s delay between cards)
```

### Trust
```
Stats: Counter animation (2s, ease-out, scroll trigger)
Badge: Slide up + fade in (scroll trigger)
```

---

## 📱 BREAKPOINTS

```
Mobile: < 768px (sm)
Tablet: 768px - 1024px (md, lg)
Desktop: >= 1024px (xl, 2xl)
```

---

## ✅ COMPLETED PHASES

- ✅ **Phase 1: Foundation** (project setup, auth, dashboard shell)
- ✅ **Phase 2: 3D Immersive Background** (5000 particles, 30 floating shapes, 8000 stars, fog, mouse parallax)
- ✅ **Phase 3: Custom GLSL Shaders** (Indian flag color wave: saffron/white/green, particle wave motion, bloom effects)
- ✅ **Phase 4: Text Scramble Effect** ("GLM Ledger" title animation with character shuffle)
- ✅ **Phase 5: Feature Cards with 3D Tilt** (holographic sheen, hover rotateX/Y, gradient sweep)
- ✅ **Phase: Trust section with counters**
- ✅ **Phase: CTA with gradient glow**
- ✅ **All pages: /, /login, /register, /dashboard, /vouchers, /gst, /reports, /inventory, /payroll, /settings**

## 🔲 REMAINING PHASES

- 🔲 Phase 6: React Spring animations (advanced physics-based animations)
- 🔲 Phase 7: Full dashboard 3D enhancements (3D charts, interactive widgets)
- 🔲 Phase 8: Backend API integration (TanStack Query for real data)
- 🔲 Phase 9: Advanced mouse interactions (click ripple effects, object attraction)
- 🔲 Phase 10: Performance optimization (code splitting, asset optimization)
- 🔲 Phase 11: Deployment (Vercel)

---

## 🚀 STARTING A NEW CHAT

1. Read this `project.md` file
2. Run `cd frontend && npm run dev`
3. Check: `http://localhost:3000`
4. Prioritize incomplete phases
5. Implement one phase at a time
6. Build → test → deploy

---

## 💡 NOTES FOR FUTURE AGENTS

- The project is stable and builds successfully
- TypeScript is set to `strict: false` for flexibility
- All major components exist and are functional
- **Phase 3 completed**: Custom GLSL shaders with Indian flag color wave (saffron/white/green)
- Text scramble effect implemented for hero title
- Mouse parallax working in 3D scene
- Focus is on visual improvements, not new features
- User wants "INDIA ke saath bhi aur bharat ke saath bhi" feeling
- User wants world class, not Indian looking design
- The 3D background is now working with custom GLSL shaders

