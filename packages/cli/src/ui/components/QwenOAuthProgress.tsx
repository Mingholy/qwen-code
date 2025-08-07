/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import Link from 'ink-link';
import qrcode from 'qrcode-terminal';
import { Colors } from '../colors.js';
import { DeviceAuthorizationInfo } from '../hooks/useQwenAuth.js';

interface QwenOAuthProgressProps {
  onTimeout: () => void;
  onCancel: () => void;
  deviceAuth?: DeviceAuthorizationInfo;
  authStatus?: 'idle' | 'polling' | 'success' | 'error' | 'timeout';
  authMessage?: string | null;
}

export function QwenOAuthProgress({
  onTimeout,
  onCancel,
  deviceAuth,
  authStatus,
  authMessage,
}: QwenOAuthProgressProps): React.JSX.Element {
  const defaultTimeout = deviceAuth?.expires_in || 300; // Default 5 minutes
  const [timeRemaining, setTimeRemaining] = useState<number>(defaultTimeout);
  const [dots, setDots] = useState<string>('');
  const [qrCodeData, setQrCodeData] = useState<string | null>(null);
  const [globalTimeRemaining, setGlobalTimeRemaining] =
    useState<number>(defaultTimeout);

  useInput((input, key) => {
    if (authStatus === 'timeout') {
      // Any key press in timeout state should trigger cancel to return to auth dialog
      onCancel();
    } else if (key.escape) {
      onCancel();
    }
  });

  // Generate QR code when device auth is available
  useEffect(() => {
    if (!deviceAuth) {
      setQrCodeData(null);
      return;
    }

    // Generate QR code string
    const generateQR = () => {
      try {
        qrcode.generate(
          deviceAuth.verification_uri_complete,
          { small: true },
          (qrcode: string) => {
            setQrCodeData(qrcode);
          },
        );
      } catch (error) {
        console.error('Failed to generate QR code:', error);
        setQrCodeData(null);
      }
    };

    generateQR();
  }, [deviceAuth]);

  // Global timeout timer (always runs regardless of deviceAuth)
  useEffect(() => {
    const globalTimer = setInterval(() => {
      setGlobalTimeRemaining((prev) => {
        if (prev <= 1) {
          onTimeout();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(globalTimer);
  }, [onTimeout]);

  // Countdown timer (only when deviceAuth is available)
  useEffect(() => {
    if (!deviceAuth) return;

    const timer = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 1) {
          onTimeout();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [deviceAuth, onTimeout]);

  // Animated dots
  useEffect(() => {
    const dotsTimer = setInterval(() => {
      setDots((prev) => {
        if (prev.length >= 3) return '';
        return prev + '.';
      });
    }, 500);

    return () => clearInterval(dotsTimer);
  }, []);

  const formatTime = (seconds: number): string => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  // Handle timeout state
  if (authStatus === 'timeout') {
    return (
      <Box
        borderStyle="round"
        borderColor={Colors.AccentRed}
        flexDirection="column"
        padding={1}
        width="100%"
      >
        <Text bold color={Colors.AccentRed}>
          Qwen OAuth Authentication Timeout
        </Text>

        <Box marginTop={1}>
          <Text>
            {authMessage ||
              `OAuth token expired (over ${defaultTimeout} seconds). Please select authentication method again.`}
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text color={Colors.Gray}>
            Press any key to return to authentication type selection.
          </Text>
        </Box>
      </Box>
    );
  }

  if (!deviceAuth) {
    return (
      <Box
        borderStyle="round"
        borderColor={Colors.Gray}
        flexDirection="column"
        padding={1}
        width="100%"
      >
        <Box>
          <Text>
            <Spinner type="dots" /> Waiting for Qwen OAuth authentication...
          </Text>
        </Box>
        <Box marginTop={1} justifyContent="space-between">
          <Text color={Colors.Gray}>
            Time remaining: {formatTime(globalTimeRemaining)}
          </Text>
          <Text color={Colors.AccentPurple}>(Press ESC to cancel)</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor={Colors.AccentBlue}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold color={Colors.AccentBlue}>
        Qwen OAuth Authentication
      </Text>

      <Box marginTop={1}>
        <Text>Please visit this URL to authorize:</Text>
      </Box>
      <Link url={deviceAuth.verification_uri_complete} fallback={false}>
        <Text color={Colors.AccentGreen} bold>
          {deviceAuth.verification_uri_complete}
        </Text>
      </Link>
      {qrCodeData && (
        <>
          <Box marginTop={1}>
            <Text>Or scan the QR code below:</Text>
          </Box>
          <Box marginTop={1}>
            <Text>{qrCodeData}</Text>
          </Box>
        </>
      )}

      <Box marginTop={1}>
        <Text>
          <Spinner type="dots" /> Waiting for authorization{dots}
        </Text>
      </Box>

      <Box marginTop={1} justifyContent="space-between">
        <Text color={Colors.Gray}>
          Time remaining: {formatTime(timeRemaining)}
        </Text>
        <Text color={Colors.AccentPurple}>(Press ESC to cancel)</Text>
      </Box>
    </Box>
  );
}
