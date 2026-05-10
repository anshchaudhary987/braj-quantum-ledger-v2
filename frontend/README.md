# GLM Ledger Frontend

Next-generation accounting software frontend for Indian businesses.

## Features

- **3D Immersive Landing Page** with WebGL animations
- **Dark Mode Glassmorphism Design** (Indigo + Saffron color scheme)
- **Authentication** with JWT and company selection
- **Real-time Dashboard** with KPIs, charts, and GST compliance widgets
- **Responsive Design** for all devices
- **API Integration** with existing Express backend

## Tech Stack

- Next.js 15 (App Router)
- React 19 + TypeScript
- Tailwind CSS + shadcn/ui
- React Three Fiber (3D)
- Framer Motion (Animations)
- Zustand (State Management)
- TanStack Query (Server State)
- Recharts (Charts)
- Axios (API Client)

## Getting Started

### Prerequisites

- Node.js 20+
- Backend server running (see main project)

### Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the app.

### Production Build

```bash
# Build for production
npm run build

# Start production server
npm start
```

## Project Structure

```
frontend/
├── src/
│   ├── app/              # Next.js pages
│   ├── components/       # React components
│   │   ├── 3d/         # Three.js 3D scenes
│   │   ├── auth/       # Authentication forms
│   │   ├── dashboard/  # Dashboard components
│   │   └── landing/    # Landing page sections
│   ├── hooks/          # Custom React hooks
│   ├── lib/            # Utilities and API client
│   ├── store/          # Zustand stores
│   └── types/          # TypeScript types
├── public/             # Static assets
└── package.json
```

## Environment Variables

Create a `.env.local` file:

```env
NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1
```

## Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run lint` - Run ESLint

## Deployment

This project is configured for Vercel deployment. Connect your GitHub repository to Vercel for automatic deployments.
