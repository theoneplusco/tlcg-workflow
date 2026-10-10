#!/bin/bash

# Script tự động deploy lên Netlify
# Cách dùng: ./deploy.sh

echo "🚀 Bắt đầu deploy lên Netlify..."

# Chuyển đến thư mục project
cd "/Volumes/MacEx01/TLCG Workflow"

# Kiểm tra Netlify CLI
if ! command -v netlify &> /dev/null; then
    echo "❌ Netlify CLI chưa được cài đặt"
    echo "📦 Cài đặt: npm install -g netlify-cli"
    exit 1
fi

# Kiểm tra đã login chưa
if [ ! -f .netlify/state.json ]; then
    echo "🔐 Chưa đăng nhập Netlify. Đang mở browser để login..."
    netlify login
fi

# Deploy
echo "📤 Đang deploy..."
netlify deploy --prod

# Kiểm tra kết quả
if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Deploy thành công!"
    echo "🌐 Site URL: https://wf.tl-c.us"
    echo ""
    echo "💡 Tip: Bạn có thể mở site bằng lệnh: netlify open:site"
else
    echo ""
    echo "❌ Deploy thất bại. Vui lòng kiểm tra lỗi ở trên."
    exit 1
fi


