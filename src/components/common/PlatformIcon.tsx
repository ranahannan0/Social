import React from 'react';
import {
  Linkedin,
  Twitter,
  Video,
  Instagram,
  Youtube,
  Smartphone,
  Pin,
  MessageSquare,
  Mail,
  FileText,
} from 'lucide-react';
import { PlatformType } from '../../types';

interface PlatformIconProps {
  platform: PlatformType | string;
  className?: string;
  size?: number;
}

export const PlatformIcon: React.FC<PlatformIconProps> = ({ platform, className = 'w-4 h-4', size }) => {
  switch (platform) {
    case 'linkedin':
      return <Linkedin className={className} size={size} />;
    case 'x':
      return <Twitter className={className} size={size} />;
    case 'instagram_reels':
      return <Video className={className} size={size} />;
    case 'instagram_feed':
      return <Instagram className={className} size={size} />;
    case 'youtube':
      return <Youtube className={className} size={size} />;
    case 'tiktok':
      return <Smartphone className={className} size={size} />;
    case 'pinterest':
      return <Pin className={className} size={size} />;
    case 'whatsapp':
      return <MessageSquare className={className} size={size} />;
    case 'email':
      return <Mail className={className} size={size} />;
    case 'blog_seo':
      return <FileText className={className} size={size} />;
    default:
      return <FileText className={className} size={size} />;
  }
};
