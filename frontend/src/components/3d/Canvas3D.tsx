'use client';

import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, RoundedBox, Text3D, Center, MeshDistortMaterial, Stars } from '@react-three/drei';
import * as THREE from 'three';

function FloatingRupee() {
  const meshRef = useRef<THREE.Mesh>(null);
  
  return (
    <Float
      speed={4}
      rotationIntensity={0.5}
      floatIntensity={2}
    >
      <mesh ref={meshRef} position={[0, 0, 0]}>
        <RoundedBox args={[3, 3, 0.5]} radius={0.1} smoothness={4}>
          <MeshDistortMaterial
            color="#FF6F00"
            emissive="#FF6F00"
            emissiveIntensity={0.2}
            roughness={0.1}
            metalness={0.8}
            distort={0.3}
            speed={2}
          />
        </RoundedBox>
        <Center position={[0, 0, 0.26]}>
          <Text3D
            font="https://threejs.org/examples/fonts/helvetiker_bold.typeface.json"
            size={0.8}
            height={0.1}
            curveSegments={12}
          >
            ₹
            <meshStandardMaterial color="#FFFFFF" emissive="#FF6F00" emissiveIntensity={0.5} />
          </Text3D>
        </Center>
      </mesh>
    </Float>
  );
}

function ParticleField() {
  const pointsRef = useRef<THREE.Points>(null);
  
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(500 * 3);
    for (let i = 0; i < 500; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 20;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 20;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 20;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geo;
  }, []);

  useFrame((state) => {
    if (pointsRef.current) {
      pointsRef.current.rotation.y = state.clock.elapsedTime * 0.02;
      pointsRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.05) * 0.1;
    }
  });

  return (
    <points ref={pointsRef} geometry={geometry}>
      <pointsMaterial
        size={0.05}
        color="#FF6F00"
        transparent
        opacity={0.6}
        sizeAttenuation
      />
    </points>
  );
}

function FloatingOrbs() {
  const orbsRef = useRef<THREE.Group>(null);
  
  useFrame((state) => {
    if (orbsRef.current) {
      orbsRef.current.rotation.y = state.clock.elapsedTime * 0.05;
    }
  });

  return (
    <group ref={orbsRef}>
      {[...Array(4)].map((_, i) => {
        const angle = (i / 4) * Math.PI * 2;
        const radius = 6 + Math.sin(i) * 2;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        
        return (
          <Float key={i} speed={2} rotationIntensity={0.3} floatIntensity={1}>
            <mesh position={[x, 0, z]}>
              <sphereGeometry args={[0.3, 16, 16]} />
              <meshStandardMaterial
                color={i % 2 === 0 ? '#FF6F00' : '#1A237E'}
                emissive={i % 2 === 0 ? '#FF6F00' : '#1A237E'}
                emissiveIntensity={0.5}
                transparent
                opacity={0.8}
              />
            </mesh>
          </Float>
        );
      })}
    </group>
  );
}

function Scene() {
  return (
    <>
      <ambientLight intensity={0.3} color="#FF6F00" />
      <directionalLight position={[10, 10, 5]} intensity={1} color="#FFFFFF" />
      <pointLight position={[-10, -10, -10]} intensity={0.5} color="#FF6F00" />
      
      <FloatingRupee />
      <ParticleField />
      <FloatingOrbs />
      <Stars radius={20} depth={50} count={500} factor={4} saturation={0} fade speed={1} />
      
      <fog attach="fog" args={['#0a0a1a', 5, 25]} />
    </>
  );
}

export default function Canvas3D() {
  return (
    <div className="absolute inset-0 z-0">
      <Canvas
        camera={{ position: [0, 0, 10], fov: 50 }}
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

