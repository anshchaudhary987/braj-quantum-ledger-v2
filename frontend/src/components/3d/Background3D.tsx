'use client';

import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

function ParticleCloud() {
  const pointsRef = useRef<THREE.Points>(null);
  
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(200 * 3);
    for (let i = 0; i < 200; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 30;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 30;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 20;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geo;
  }, []);

  useFrame((state) => {
    if (pointsRef.current) {
      pointsRef.current.rotation.y = state.clock.elapsedTime * 0.01;
    }
  });

  return (
    <points ref={pointsRef} geometry={geometry}>
      <pointsMaterial
        size={0.08}
        color="#FF6F00"
        transparent
        opacity={0.4}
        sizeAttenuation
      />
    </points>
  );
}

function FloatingShapes() {
  const groupRef = useRef<THREE.Group>(null);
  
  useFrame((state) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = state.clock.elapsedTime * 0.02;
    }
  });

  const shapes = [
    { type: 'sphere', position: [-5, 3, -5] as [number, number, number], color: '#FF6F00', size: 0.5 },
    { type: 'box', position: [5, -2, -3] as [number, number, number], color: '#1A237E', size: 0.6 },
  ];

  return (
    <group ref={groupRef}>
      {shapes.map((shape, index) => (
        <mesh key={index} position={shape.position}>
          {shape.type === 'sphere' && <sphereGeometry args={[shape.size, 16, 16]} />}
          {shape.type === 'box' && <boxGeometry args={[shape.size, shape.size, shape.size]} />}
          <meshStandardMaterial
            color={shape.color}
            emissive={shape.color}
            emissiveIntensity={0.3}
            transparent
            opacity={0.6}
          />
        </mesh>
      ))}
    </group>
  );
}

function Scene() {
  return (
    <>
      <ambientLight intensity={0.2} />
      <pointLight position={[10, 10, 10]} color="#FF6F00" intensity={0.5} />
      <pointLight position={[-10, -10, -10]} color="#1A237E" intensity={0.5} />
      <ParticleCloud />
      <FloatingShapes />
      <fog attach="fog" args={['#0a0a1a', 10, 40]} />
    </>
  );
}

export default function Background3D() {
  return (
    <div className="absolute inset-0 -z-10">
      <Canvas
        camera={{ position: [0, 0, 10], fov: 60 }}
        style={{ background: 'transparent' }}
        gl={{ 
          antialias: false, 
          alpha: true,
          powerPreference: "high-performance"
        }}
        dpr={1}
      >
        <Scene />
      </Canvas>
    </div>
  );
}

