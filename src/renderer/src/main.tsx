import React from 'react'
import ReactDOM from 'react-dom/client'
import '@ant-design/v5-patch-for-react-19'
import { ConfigProvider, theme, App as AntdApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#0071e3',
          colorInfo: '#0071e3',
          colorTextBase: '#1d1d1f',
          colorTextSecondary: '#6e6e73',
          colorBorder: '#d2d2d7',
          colorBorderSecondary: '#e8e8ed',
          borderRadius: 10,
          borderRadiusLG: 14,
          controlHeight: 34,
          boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei UI', sans-serif"
        },
        components: {
          Layout: {
            siderBg: '#fbfbfd',
            headerBg: 'rgba(255,255,255,0.82)',
            bodyBg: '#f5f5f7'
          },
          Menu: {
            itemBg: 'transparent',
            itemColor: '#424245',
            itemHoverColor: '#1d1d1f',
            itemSelectedBg: 'rgba(0,113,227,0.10)',
            itemSelectedColor: '#0071e3',
            itemHeight: 40,
            itemMarginInline: 10,
            itemBorderRadius: 9
          }
        }
      }}
    >
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>
)
