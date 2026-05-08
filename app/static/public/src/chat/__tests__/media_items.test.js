import { describe, expect, it } from 'vitest';
import { buildMediaItems } from '../media_items.js';

describe('buildMediaItems', () => {
  it('优先使用 card key，并去重 extraImages', () => {
    const rendering = {
      rawModelResponse: {
        cardAttachmentsJson: [
          JSON.stringify({
            id: 'abc',
            type: 'render_generated_image',
            image: {
              original: '/foo/bar.png',
              title: 'test image'
            }
          })
        ]
      },
      extraImages: ['/foo/bar.png', '/foo/baz.png']
    };

    const items = buildMediaItems(rendering);
    expect(items[0].key).toBe('card:abc');
    expect(items.some((item) => item.key === 'url:/v1/files/image/foo/baz.png')).toBe(true);
  });

  it('无效来源链接不会退化成可见 badge 文本', () => {
    const rendering = {
      rawModelResponse: {
        cardAttachmentsJson: [
          JSON.stringify({
            id: 'broken',
            type: 'render_generated_image',
            image: {
              original: '/foo/demo.png',
              link: 'citation_card\'',
              title: 'demo'
            }
          })
        ]
      }
    };

    const items = buildMediaItems(rendering);
    expect(items).toHaveLength(1);
    expect(items[0].sourceHref).toBe('');
    expect(items[0].sourceLabel).toBe('');
  });

  it('把 4.3 返回文件转成代理地址', () => {
    const rendering = {
      rawModelResponse: {
        cardAttachmentsJson: [
          JSON.stringify({
            id: 'file1',
            type: 'render_file',
            cardType: 'rendered_file_card',
            file_name: 'silent_test.mp4',
            content_type: 'video',
            mime_type: 'video/mp4',
            file_size: 900962,
            url: 'users/demo/generated/abc/silent_test.mp4'
          })
        ]
      }
    };

    const items = buildMediaItems(rendering);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('video');
    expect(items[0].name).toBe('silent_test.mp4');
    expect(items[0].src).toBe('/v1/files/asset/users/demo/generated/abc/silent_test.mp4');
  });

  it('保留已经保存到本地的返回文件地址', () => {
    const rendering = {
      rawModelResponse: {
        cardAttachmentsJson: [
          JSON.stringify({
            id: 'zip1',
            type: 'render_file',
            file_name: 'image.zip',
            mime_type: 'application/zip',
            url: 'users/demo/generated/image.zip'
          })
        ]
      },
      files: [
        {
          id: 'zip1',
          name: 'image.zip',
          mime: 'application/zip',
          size: 177528,
          url: '/v1/files/file/users-demo-generated-image.zip'
        }
      ]
    };

    const items = buildMediaItems(rendering);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('file');
    expect(items[0].src).toBe('/v1/files/file/users-demo-generated-image.zip');
  });
});
