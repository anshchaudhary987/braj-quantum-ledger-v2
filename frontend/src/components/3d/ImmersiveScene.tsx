'use client';

import React, { useRef, useMemo, useState, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Stars, Float } from '@react-three/drei';
import * as THREE from 'three';

// Modern Professional Color Palette
// Primary: Sky Blue #7DD3FC
// Secondary: Soft Lavender #A78BFA
// Background: Deep Slate #0F172A
// Success: Teal Green #34D399
// Accent: Cyan #22D3EE

// Custom hook for mouse position
function useMousePosition() {
  const mouse = useRef({ x: 0, y: 0 });
  
  React.useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      mouse.current = {
        x: (e.clientX / window.innerWidth) * 2 - 1,
        y: (e.clientY / window.innerHeight) * 2 - 1,
      };
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);
  
  return mouse;
}

// Custom GLSL Shader Material for particles with Modern Professional colors
function ParticleShaderMaterial() {
  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uMouse: { value: new THREE.Vector2(0, 0) },
    uResolution: { value: new THREE.Vector2(1, 1) },
  }), []);

  const vertexShader = `
    uniform float uTime;
    varying vec3 vColor;
    varying float vAlpha;
    
    void main() {
      vec3 pos = position;
      
      // Wave motion based on time
      pos.x += sin(uTime * 0.5 + position.y * 0.1) * 2.0;
      pos.y += cos(uTime * 0.3 + position.x * 0.1) * 2.0;
      pos.z += sin(uTime * 0.4 + position.x * 0.1 + position.y * 0.1) * 2.0;
      
      vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      gl_PointSize = (300.0 / -mvPosition.z) * (0.5 + 0.5 * sin(uTime + position.x));
      
      // Modern Professional Colors: Sky Blue, Lavender, Cyan, Teal
      float colorPhase = sin(uTime * 0.2 + position.x * 0.02);
      vec3 skyBlue = vec3(0.49, 0.83, 0.99);    // #7DD3FC
      vec3 lavender = vec3(0.65, 0.55, 0.98);   // #A78BFA
      vec3 cyan = vec3(0.13, 0.83, 0.93);       // #22D3EE
      vec3 teal = vec3(0.20, 0.83, 0.60);       // #34D399
      
      if (colorPhase > 0.25) {
        vColor = mix(skyBlue, lavender, (colorPhase - 0.25) * 2.0);
      } else if (colorPhase > 0.0) {
        vColor = mix(lavender, cyan, (0.25 - colorPhase) * 4.0);
      } else if (colorPhase > -0.25) {
        vColor = mix(cyan, teal, (-colorPhase) * 4.0);
      } else {
        vColor = mix(teal, skyBlue, (-colorPhase - 0.25) * 2.0);
      }
      
      vAlpha = 0.8 + 0.2 * sin(uTime * 2.0 + position.x * 0.1);
    }
  `;

  const fragmentShader = `
    varying vec3 vColor;
    varying float vAlpha;
    
    void main() {
      // Circular particle with glow
      vec2 center = gl_PointCoord - 0.5;
      float dist = length(center);
      if (dist > 0.5) discard;
      
      // Glow effect
      float glow = 1.0 - smoothstep(0.0, 0.5, dist);
      vec3 finalColor = vColor * glow + vColor * 0.5 * (1.0 - glow);
      
      gl_FragColor = vec4(finalColor, vAlpha * glow);
    }
  `;

  return <shaderMaterial uniforms={uniforms} vertexShader={vertexShader} fragmentShader={fragmentShader} transparent />;
}

// 3D Moving Particles with custom shader and Modern Professional colors
function ParticleField({ mouse }: { mouse: React.MutableRefObject<{x: number, y: number}> }) {
  const pointsRef = useRef<THREE.Points>(null);
  const count = 1500;
  
  const positions = useMemo(() => {
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 150;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 150;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 150;
    }
    return pos;
  }, []);

  useFrame((state) => {
    if (pointsRef.current) {
      const material = pointsRef.current.material as THREE.ShaderMaterial;
      if (material.uniforms) {
        material.uniforms.uTime.value = state.clock.elapsedTime;
        material.uniforms.uMouse.value.set(mouse.current.x, mouse.current.y);
      }
      
      pointsRef.current.rotation.y = state.clock.elapsedTime * 0.01;
      pointsRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.05) * 0.1 + (mouse.current.y * 0.1);
      pointsRef.current.rotation.z = Math.cos(state.clock.elapsedTime * 0.03) * 0.05 + (mouse.current.x * 0.1);
    }
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
        />
      </bufferGeometry>
      <ParticleShaderMaterial />
    </points>
  );
}

// Floating geometric shapes
function FloatingShapes({ mouse }: { mouse: React.MutableRefObject<{x: number, y: number}> }) {
  const groupRef = useRef<THREE.Group>(null);
  
  const shapes = useMemo(() => {
    const arr = [];
    const geometries = ['dodecahedron', 'octahedron', 'torus', 'icosahedron'];
    // Modern Professional Colors: Sky Blue, Lavender, Cyan, Teal
    const colors = ['#7DD3FC', '#A78BFA', '#22D3EE', '#34D399', '#60A5FA', '#818CF8'];
    
    for (let i = 0; i < 12; i++) {
      arr.push({
        position: [
          (Math.random() - 0.5) * 60,
          (Math.random() - 0.5) * 60,
          (Math.random() - 0.5) * 40 - 10
        ] as [number, number, number],
        size: Math.random() * 3 + 0.5,
        color: colors[Math.floor(Math.random() * colors.length)],
        geometry: geometries[Math.floor(Math.random() * geometries.length)],
        speed: Math.random() * 2 + 0.5,
      });
    }
    return arr;
  }, []);

  useFrame((state) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = state.clock.elapsedTime * 0.02;
      groupRef.current.rotation.x = mouse.current.y * 0.2;
      groupRef.current.rotation.z = mouse.current.x * 0.2;
    }
  });

  return (
    <group ref={groupRef}>
      {shapes.map((shape, index) => (
        <Float key={index} speed={shape.speed} rotationIntensity={2} floatIntensity={3}>
          <mesh position={shape.position}>
            {shape.geometry === 'dodecahedron' && <dodecahedronGeometry args={[shape.size, 0]} />}
            {shape.geometry === 'octahedron' && <octahedronGeometry args={[shape.size, 0]} />}
            {shape.geometry === 'torus' && <torusGeometry args={[shape.size, shape.size * 0.3, 16, 32]} />}
            {shape.geometry === 'icosahedron' && <icosahedronGeometry args={[shape.size, 0]} />}
            <meshStandardMaterial
              color={shape.color}
              emissive={shape.color}
              emissiveIntensity={0.4}
              metalness={0.9}
              roughness={0.1}
              transparent
              opacity={0.8}
            />
          </mesh>
        </Float>
      ))}
    </group>
  );
}

// Main Scene
function Scene() {
  const mouse = useMousePosition();

  return (
    <>
      {/* Lighting - Cool tones for modern feel */}
      <ambientLight intensity={0.3} />
      <pointLight position={[10, 10, 10]} color="#7DD3FC" intensity={2} />
      <pointLight position={[-10, -10, -10]} color="#A78BFA" intensity={2} />
      <pointLight position={[0, 0, 5]} color="#22D3EE" intensity={0.5} />
      <directionalLight position={[5, 5, 5]} intensity={1} />
      
      {/* 3D Elements */}
      <ParticleField mouse={mouse} />
      <FloatingShapes mouse={mouse} />
      <Stars radius={120} depth={60} count={2500} factor={5} saturation={0} fade speed={0.5} />
      
      {/* Fog - Deep Slate */}
      <fog attach="fog" args={['#0F172A', 20, 180]} />
    </>
  );
}

// Text Scramble Effect Component
export function TextScramble({ text, className }: { text: string; className?: string }) {
  const [displayText, setDisplayText] = useState(text);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  
  useEffect(() => {
    let iteration = 0;
    const originalText = text;
    
    const interval = setInterval(() => {
      setDisplayText(
        originalText
          .split('')
          .map((char, index) => {
            if (char === ' ') return ' ';
            if (index < iteration) return originalText[index];
            return chars[Math.floor(Math.random() * chars.length)];
          })
          .join('')
      );
      
      if (iteration >= originalText.length) {
        clearInterval(interval);
      }
      
      iteration += 1 / 3;
    }, 30);
    
    return () => clearInterval(interval);
  }, [text]);
  
  return <span className={className}>{displayText}</span>;
}

export default function ImmersiveScene() {
  return <Scene />;
}

// Export the full component
export function ImmersiveBackground() {
  return (
    <div className="fixed inset-0 w-full h-full -z-10" style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: -1 }}>
      <Canvas
        camera={{ position: [0, 0, 50], fov: 60, near: 0.1, far: 200 }}
        gl={{ 
          antialias: false, 
          alpha: true,
          powerPreference: "high-performance"
        }}
        style={{ 
          background: 'linear-gradient(to bottom, #0F172A 0%, #1E293B 50%, #0F172A 100%)',
          width: '100%',
          height: '100%'
        }}
        dpr={1}
      >
        <ImmersiveScene />
      </Canvas>
    </div>
  );
}

